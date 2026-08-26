import type {
  FocusedLocatorRetrievalV2Candidate,
  FocusedLocatorRetrievalV2Port,
  FocusedLocatorRetrievalV2RequestSnapshot,
  FocusedLocatorRetrievalV2Result,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { createHash } from "node:crypto";
import {
  CONTEXT_RETRIEVAL_CONTRACT_V2,
  CONTEXT_RETRIEVAL_RANKING_POLICY_V2,
  InfinityContextClient,
  InfinityContextError,
  FetchTransport,
  assertContextRetrievalCapabilityV2,
  retrievalV2RequestPayload,
  type HttpTransport,
  type RetrieveContextV2Input,
} from "@infinity-context/sdk-v2";

import { InfinityOperationDeadline } from "./infinity-request-deadline.js";

export type InfinityContextRetrievalV2Binding =
  FocusedLocatorRetrievalV2RequestSnapshot["binding"];
export type InfinityContextRetrievalV2Request =
  FocusedLocatorRetrievalV2RequestSnapshot;

export interface InfinityContextRetrievalV2Config {
  readonly baseUrl: string;
  readonly operationTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly token?: string | (() => Promise<string | null | undefined> | string | null | undefined);
  /** Test-only injection; all requests still traverse the official SDK. */
  readonly transport?: HttpTransport;
}

export interface InfinityContextRetrievalV2Observation {
  readonly capabilityAndRetrievalLatencyUs: number;
  readonly capabilityBytes: number;
  readonly capabilitySha256: string;
  readonly requestBytes: number;
  readonly requestSha256: string;
  readonly responseBytes: number;
  readonly responseSha256: string;
  readonly routeLatencyUs: number;
}

export interface InfinityContextRetrievalV2ExactExchange {
  readonly requestBytes: Uint8Array;
  readonly responseBytes: Uint8Array;
}

function unavailable(code: string, retryable: boolean): FocusedLocatorRetrievalV2Result {
  return Object.freeze({ code, retryable, status: "unavailable" });
}

function unqualified(code: string): FocusedLocatorRetrievalV2Result {
  return Object.freeze({ code, retryable: false, status: "unqualified" });
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

/** ADR-0049 canonical producer fingerprint, excluding the digest field itself. */
export function retrievalV2CapabilityFingerprint(
  capability: Readonly<Record<string, unknown>>,
): string {
  const { capability_fingerprint: _emittedFingerprint, ...producerValues } = capability;
  return createHash("sha256")
    .update(JSON.stringify(canonicalFingerprintValue(producerValues)), "utf8")
    .digest("hex");
}

function canonicalFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalFingerprintValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const encoder = new TextEncoder();
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => {
      const leftBytes = encoder.encode(left);
      const rightBytes = encoder.encode(right);
      const shared = Math.min(leftBytes.length, rightBytes.length);
      for (let index = 0; index < shared; index += 1) {
        const difference = leftBytes[index]! - rightBytes[index]!;
        if (difference !== 0) {return difference;}
      }
      return leftBytes.length - rightBytes.length;
    })
    .map(([key, nested]) => [key, canonicalFingerprintValue(nested)]));
}

function requestFrom(input: InfinityContextRetrievalV2Request): RetrieveContextV2Input {
  const runtimeInput = input as unknown as { readonly schemaVersion: unknown;
    readonly binding: { readonly contractVersion: unknown; readonly rankingPolicy: unknown };
    readonly budgets: { readonly neighborRadius: unknown } };
  if (
    !exactKeys(input, [
      "binding", "budgets", "filters", "queries", "schemaVersion", "scope",
      "softPreferences",
    ]) ||
    !exactKeys(input.binding, [
      "capabilityFingerprint", "contractVersion", "indexProfileDigest", "profileId",
      "rankingPolicy", "requiredProviderLanes", "serviceRevision",
    ]) ||
    !exactKeys(input.budgets, [
      "candidateLimit", "deadlineMs", "evidenceByteLimit", "neighborRadius",
      "responseByteLimit", "resultLimit",
    ]) ||
    !exactKeys(input.scope, [
      "memoryScopeId", "spaceId",
      ...(input.scope.threadId === undefined ? [] : ["threadId"]),
    ]) ||
    runtimeInput.schemaVersion !== 2 ||
    runtimeInput.binding.contractVersion !== CONTEXT_RETRIEVAL_CONTRACT_V2 ||
    runtimeInput.binding.rankingPolicy !== CONTEXT_RETRIEVAL_RANKING_POLICY_V2 ||
    runtimeInput.budgets.neighborRadius !== 0
  ) {
    throw new RangeError("Infinity Retrieval V2 binding or policy is invalid");
  }
  const request: RetrieveContextV2Input = {
    bounds: {
      candidateLimit: input.budgets.candidateLimit,
      deadlineMs: input.budgets.deadlineMs,
      neighborRadius: input.budgets.neighborRadius,
      responseByteLimit: input.budgets.responseByteLimit,
      resultLimit: input.budgets.resultLimit,
    },
    capabilityFingerprint: input.binding.capabilityFingerprint,
    contractVersion: CONTEXT_RETRIEVAL_CONTRACT_V2,
    filters: input.filters,
    profileId: input.binding.profileId,
    queries: input.queries,
    scope: input.scope,
    softPreferences: input.softPreferences,
  };
  // Official validation runs before either network request and rejects unknown,
  // unsafe, unordered, oversized, or out-of-contract request values.
  retrievalV2RequestPayload(request);
  return request;
}

function locatorCandidates(
  candidates: Awaited<ReturnType<InfinityContextClient["context"]["retrieve"]>>["candidates"],
): readonly FocusedLocatorRetrievalV2Candidate[] {
  return Object.freeze(candidates.map((candidate) => Object.freeze({
    locator: candidate.locator,
  })));
}

export class InfinityContextRetrievalV2Adapter
implements FocusedLocatorRetrievalV2Port {
  readonly #client: InfinityContextClient;
  readonly #operationTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  #observation: InfinityContextRetrievalV2Observation | null = null;
  #exactExchange: InfinityContextRetrievalV2ExactExchange | null = null;

  public constructor(config: InfinityContextRetrievalV2Config) {
    if (
      !Number.isSafeInteger(config.requestTimeoutMs) ||
      config.requestTimeoutMs < 1 ||
      config.requestTimeoutMs > 2_000 ||
      !Number.isSafeInteger(config.operationTimeoutMs) ||
      config.operationTimeoutMs < config.requestTimeoutMs ||
      config.operationTimeoutMs > 4_000
    ) {
      throw new RangeError("Infinity Retrieval V2 configuration is invalid");
    }
    this.#operationTimeoutMs = config.operationTimeoutMs;
    this.#requestTimeoutMs = config.requestTimeoutMs;
    const qualificationTransport = config.transport === undefined
      ? new ExactRetrievalExchangeTransport()
      : null;
    this.#qualificationTransport = qualificationTransport;
    this.#client = new InfinityContextClient({
      baseUrl: config.baseUrl,
      retryPolicy: { maxAttempts: 1 },
      timeoutMs: config.requestTimeoutMs,
      ...(config.token === undefined ? {} : { token: config.token }),
      transport: config.transport ?? qualificationTransport!,
    });
  }

  public async retrieve(
    input: InfinityContextRetrievalV2Request,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<FocusedLocatorRetrievalV2Result> {
    this.#observation = null;
    this.#exactExchange = null;
    let request: RetrieveContextV2Input;
    try {
      request = requestFrom(input);
    } catch {
      return unqualified("memory.context_retrieval_contract_invalid");
    }
    const required = {
      capabilityFingerprint: input.binding.capabilityFingerprint,
      profileId: input.binding.profileId,
      requiredProviderLanes: input.binding.requiredProviderLanes,
    };
    const timeoutMs = Math.min(this.#requestTimeoutMs, input.budgets.deadlineMs);
    const operation = new InfinityOperationDeadline(
      Math.min(this.#operationTimeoutMs, input.budgets.deadlineMs),
      options.signal,
    );
    let retrievalStarted = false;
    const operationStarted = process.hrtime.bigint();
    try {
      const capabilities = await operation.request(
        timeoutMs,
        (signal) => this.#client.system.capabilities({ signal, timeoutMs }),
      );
      const capability = assertContextRetrievalCapabilityV2(capabilities, required);
      if (
        capability.capability_fingerprint !== retrievalV2CapabilityFingerprint(
          capability as unknown as Readonly<Record<string, unknown>>,
        ) ||
        capability.service_revision !== input.binding.serviceRevision ||
        capability.index_profile_digest !== input.binding.indexProfileDigest
      ) {
        return unqualified("memory.context_retrieval_capability_mismatch");
      }
      retrievalStarted = true;
      const routeStarted = process.hrtime.bigint();
      const response = await operation.request(
        timeoutMs,
        (signal) => this.#client.context.retrieve(
          request,
          capability,
          required,
          { signal, timeoutMs },
        ),
      );
      const routeLatencyUs = Number((process.hrtime.bigint() - routeStarted) / 1_000n);
      const capabilityBytes = Buffer.from(JSON.stringify(canonicalFingerprintValue(capabilities)), "utf8");
      const { requestBytes, responseBytes } = this.captureExchangeBytes(request, response);
      this.#observation = Object.freeze({
        capabilityAndRetrievalLatencyUs:
          Number((process.hrtime.bigint() - operationStarted) / 1_000n),
        capabilityBytes: capabilityBytes.byteLength,
        capabilitySha256: createHash("sha256").update(capabilityBytes).digest("hex"),
        requestBytes: requestBytes.byteLength,
        requestSha256: createHash("sha256").update(requestBytes).digest("hex"),
        responseBytes: responseBytes.byteLength,
        responseSha256: createHash("sha256").update(responseBytes).digest("hex"),
        routeLatencyUs,
      });
      if (response.status !== "available") {
        return unqualified("memory.context_retrieval_unavailable");
      }
      return Object.freeze({
        candidates: locatorCandidates(response.candidates),
        status: "available",
      });
    } catch (error) {
      if (options.signal?.aborted === true) {
        return unavailable("memory.operation_cancelled", true);
      }
      if (error instanceof InfinityContextError) {
        if (error.code === "memory.context_retrieval_capability_mismatch") {
          return unqualified(error.code);
        }
        if (error.code === "memory.request_timeout") {
          return unavailable("memory.context_retrieval_deadline_exceeded", true);
        }
        if (
          retrievalStarted &&
          error.code === "memory.context_retrieval_contract_invalid"
        ) {
          return unavailable("memory.context_retrieval_response_invalid", false);
        }
        return unavailable(error.code, error.retryable);
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return unavailable("memory.context_retrieval_deadline_exceeded", true);
      }
      return unavailable("memory.context_retrieval_response_invalid", false);
    } finally {
      operation.close();
    }
  }

  /** Qualification-only, create-on-success observation from this concrete SDK call. */
  public takeObservation(): InfinityContextRetrievalV2Observation {
    const observation = this.#observation;
    this.#observation = null;
    if (observation === null) {
      throw new Error("Infinity Retrieval V2 has no completed concrete observation");
    }
    return observation;
  }

  /** Exact UTF-8 HTTP body bytes captured by the repo-owned production transport. */
  public takeExactExchange(): InfinityContextRetrievalV2ExactExchange {
    const exchange = this.#exactExchange;
    this.#exactExchange = null;
    if (exchange === null) {
      throw new Error("Infinity Retrieval V2 exact exchange is absent");
    }
    return exchange;
  }

  readonly #qualificationTransport: ExactRetrievalExchangeTransport | null;

  private captureExchangeBytes(request: RetrieveContextV2Input, response: unknown): {
    readonly requestBytes: Uint8Array; readonly responseBytes: Uint8Array } {
    if (this.#qualificationTransport === null) {
      return { requestBytes: Buffer.from(JSON.stringify(request), "utf8"),
        responseBytes: Buffer.from(JSON.stringify(response), "utf8") };
    }
    const exchange = this.#qualificationTransport.takeRetrievalExchange();
    this.#exactExchange = exchange;
    return exchange;
  }
}

class ExactRetrievalExchangeTransport implements HttpTransport {
  readonly #delegate = new FetchTransport();
  #exchange: InfinityContextRetrievalV2ExactExchange | null = null;

  public async send(request: Parameters<HttpTransport["send"]>[0]) {
    const isRetrieval = request.method === "POST" &&
      request.url.pathname.endsWith("/context/retrieve");
    const requestBytes = isRetrieval ? exactHttpBodyBytes(request.body) : null;
    const response = await this.#delegate.send(request);
    if (isRetrieval) {
      this.#exchange = Object.freeze({ requestBytes: requestBytes!,
        responseBytes: typeof response.body === "string"
          ? new TextEncoder().encode(response.body)
          : new Uint8Array(response.body) });
    }
    return response;
  }

  public takeRetrievalExchange(): InfinityContextRetrievalV2ExactExchange {
    const exchange = this.#exchange;
    this.#exchange = null;
    if (exchange === null) {throw new Error("Infinity retrieval HTTP exchange was not captured");}
    return exchange;
  }
}

function exactHttpBodyBytes(body: Parameters<HttpTransport["send"]>[0]["body"]): Uint8Array {
  if (body?.kind === "json") {return new TextEncoder().encode(JSON.stringify(body.value));}
  if (body?.kind === "bytes" && typeof body.value === "string") {
    return new TextEncoder().encode(body.value);
  }
  if (body?.kind === "bytes" && body.value instanceof Uint8Array) {
    return new Uint8Array(body.value);
  }
  throw new Error("Infinity retrieval request body is not exact byte-addressable data");
}
