import type {
  GroundedAnswerGenerationRequest,
  GroundedAnswerGenerationResult,
  GroundedAnswerGenerator,
  GroundedAnswerMeasurement,
  SpeakerAliasMapV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { createHash } from "node:crypto";

import {
  type AttestationExpectation,
  verifySubscriptionRuntimeAttestation,
} from "./attestation.js";
import {
  buildSubscriptionRuntimeKnowledgeAnswerRequest,
  knowledgeAnswerRuntimeProfile,
  type KnowledgeAnswerRequestOptions,
} from "./knowledge-answer-request-mapper.js";
import { providerKnowledgeAnswerSchema } from "./provider-knowledge-schema.js";
import { stableSubscriptionRuntimeId } from "./stable-id.js";
import {
  validateAttestationExpectation,
} from "./summary-adapter-options.js";
import {
  subscriptionRuntimeKnowledgeAnswerMaxOutputTokens,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeEngine,
  type KnowledgeAnswerQualificationExecutionBinding,
  type SubscriptionRuntimeTaskResult,
  type SubscriptionRuntimeTransportPort,
} from "./subscription-runtime-contract.js";

const defaultIsolatedCwd = "/run/discord-meeting-subscription-runtime/workspace";
const defaultTimeoutMs = 180_000;
export const knowledgeAnswerMaximumModelInputBytes = 16_000;

export interface KnowledgeAnswerExactInputMeasurement {
  readonly maximumModelInputBytes: number;
  readonly original: KnowledgeAnswerModelInputSurfaceMeasurement;
  readonly repair: KnowledgeAnswerModelInputSurfaceMeasurement;
}

export interface KnowledgeAnswerModelInputSurfaceMeasurement {
  /** Exact UTF-8 bytes of systemPrompt + LF + prompt + LF + output schema JSON. */
  readonly fullInputBytes: number;
  readonly outputSchemaBytes: number;
  readonly systemPromptBytes: number;
  readonly userPromptBytes: number;
}

export interface PreparedKnowledgeAnswerRuntimeRequest {
  readonly exactInput: KnowledgeAnswerExactInputMeasurement;
  readonly modelInputs: { readonly original: string; readonly repair: string };
  readonly request: ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest>;
}

export interface KnowledgeAnswerQualificationObservation {
  readonly attemptId: string;
  readonly exchanges: {
    readonly original: KnowledgeAnswerProviderExchange;
    readonly repair: KnowledgeAnswerProviderExchange | null;
  };
  readonly outcomeCertain: boolean;
  readonly providerBytesSent: boolean;
  readonly responseBytes: number;
  readonly runtimeReceiptSha256: string;
}
export interface KnowledgeAnswerProviderExchange {
  readonly identity: KnowledgeAnswerProviderExchangeIdentity;
  readonly requestBytes: Uint8Array;
  readonly responseBytes: Uint8Array;
}
export interface KnowledgeAnswerProviderExchangeIdentity {
  readonly attemptId: string;
  readonly callOrdinal: "original" | "repair";
  readonly executionBinding?: KnowledgeAnswerQualificationExecutionBinding;
  readonly purpose: string;
  readonly runId: string;
  readonly runtimeProfile: {
    readonly maxOutputTokens: number;
    readonly model: string;
    readonly outputSchemaName: string;
    readonly policyVersion: string;
    readonly reasoningEffort: string;
  };
}
export interface KnowledgeAnswerWireObservationPort {
  execute(
    identity: KnowledgeAnswerProviderExchangeIdentity,
    request: SubscriptionRuntimeAgentTaskRequest,
    options: { readonly signal?: AbortSignal },
  ): Promise<SubscriptionRuntimeTaskResult>;
  take(identity: KnowledgeAnswerProviderExchangeIdentity): {
    readonly requestBytes: Uint8Array | null;
    readonly responseBytes: Uint8Array | null;
  };
  finish(attemptId: string): void;
}

export interface KnowledgeAnswerTokenCounter {
  readonly profile: string;
  countInputTokens(input: string): number;
}

/**
 * Fail-safe production fallback while the exact Sol tokenizer is not available
 * locally: every UTF-8 byte consumes one budget unit, which cannot undercount a
 * normal text token. Its distinct profile keeps qualification evidence honest.
 */
export const utf8ByteUpperBoundKnowledgeTokenCounter: KnowledgeAnswerTokenCounter =
  Object.freeze({
    countInputTokens: (input: string) => new TextEncoder().encode(input).byteLength,
    profile: "utf8-byte-upper-bound.v1",
  });

export interface SubscriptionRuntimeGroundedAnswerAdapterOptions {
  readonly expectedLauncherSha256: string;
  readonly expectedRuntimeEngine?: SubscriptionRuntimeEngine;
  readonly expectedRuntimePackageVersion?: string;
  readonly isolatedCwd?: string;
  readonly maxOutputTokens?: number;
  readonly speakerAliases?: SpeakerAliasMapV1;
  readonly timeoutMs?: number;
  readonly tokenCounter?: KnowledgeAnswerTokenCounter;
}

export class SubscriptionRuntimeGroundedAnswerAdapter
  implements GroundedAnswerGenerator
{
  readonly #transport: SubscriptionRuntimeTransportPort;
  readonly #wireObservation: KnowledgeAnswerWireObservationPort | undefined;
  readonly #qualificationExecutionBinding: KnowledgeAnswerQualificationExecutionBinding | undefined;
  private readonly attestation: AttestationExpectation;
  private readonly requestOptions: KnowledgeAnswerRequestOptions;
  private readonly tokenCounter: KnowledgeAnswerTokenCounter;
  private readonly qualificationObservations = new Map<string,
    KnowledgeAnswerQualificationObservation>();

  public constructor(
    transport: SubscriptionRuntimeTransportPort,
    options: SubscriptionRuntimeGroundedAnswerAdapterOptions,
    wireObservation?: KnowledgeAnswerWireObservationPort,
    qualificationExecutionBinding?: KnowledgeAnswerQualificationExecutionBinding,
  ) {
    this.#transport = transport;
    this.#wireObservation = wireObservation;
    this.#qualificationExecutionBinding = qualificationExecutionBinding === undefined ? undefined :
      Object.freeze({ ...qualificationExecutionBinding });
    this.attestation = validateAttestationExpectation(options);
    this.requestOptions = validateRequestOptions(options);
    this.tokenCounter = options.tokenCounter ?? utf8ByteUpperBoundKnowledgeTokenCounter;
    Object.freeze(this);
  }

  public async measure(
    request: GroundedAnswerGenerationRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<GroundedAnswerMeasurement & KnowledgeAnswerExactInputMeasurement> {
    options.signal?.throwIfAborted();
    const prepared = this.prepare(request);
    const runtimeRequest = prepared.request;
    const exactInput = prepared.exactInput;
    const input = inputSurface(runtimeRequest);
    const inputTokens = this.tokenCounter.countInputTokens(input);
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 1) {
      throw new Error("knowledge input token counter returned an invalid measurement");
    }
    return {
      ...exactInput,
      inputTokens,
      requestBytes: new TextEncoder().encode(JSON.stringify(runtimeRequest)).byteLength,
      runtimeProfile: `${knowledgeAnswerRuntimeProfile}:${this.tokenCounter.profile}`,
    };
  }

  public async generate(
    request: GroundedAnswerGenerationRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<GroundedAnswerGenerationResult> {
    options.signal?.throwIfAborted();
    let runtimeRequest = this.prepare(request).request;
    let repairedProviderOutput = false;
    let result;
    const observedExchanges: KnowledgeAnswerProviderExchange[] = [];
    const executionState = { providerBytesSent: false };
    const capture = { exchanges: observedExchanges, executionState };
    try {
      result = await this.executeObserved(request.attemptId, "original", runtimeRequest, options,
        capture);
      if (
        result.protocolVersion === 1 &&
        result.status === "failed" &&
        result.failure.code === "provider_output_invalid"
      ) {
        options.signal?.throwIfAborted();
        runtimeRequest = providerOutputRepairRequest(runtimeRequest);
        result = await this.executeObserved(request.attemptId, "repair", runtimeRequest, options,
          capture);
        repairedProviderOutput = true;
      }
    } catch {
      try {
        this.recordQualificationObservation(request.attemptId, observedExchanges, false,
          executionState.providerBytesSent);
      } finally {
        this.#wireObservation?.finish(request.attemptId);
      }
      options.signal?.throwIfAborted();
      return { code: "runtime_unavailable", retryable: true, status: "failed" };
    }
    try {
      this.recordQualificationObservation(request.attemptId, observedExchanges, true);
    } finally {
      this.#wireObservation?.finish(request.attemptId);
    }
    if (result.protocolVersion !== 1) {
      return invalidOutput("unsupported_protocol");
    }
    if (result.status === "waiting_for_input") {
      return invalidOutput("interactive_input_forbidden");
    }
    if (result.status === "failed") {
      return {
        code: result.failure.code,
        retryable: repairedProviderOutput &&
            result.failure.code === "provider_output_invalid"
          ? false
          : result.failure.retryable || result.failure.reconnectRequired,
        status: "failed",
      };
    }
    try {
      verifySubscriptionRuntimeAttestation(runtimeRequest, result, this.attestation);
      const parsed = providerKnowledgeAnswerSchema.safeParse(result.structuredOutput);
      return parsed.success
        ? { answer: parsed.data, status: "completed" }
        : invalidOutput("provider_output_invalid");
    } catch {
      return invalidOutput("invalid_attestation");
    }
  }

  public takeQualificationObservation(attemptId: string): KnowledgeAnswerQualificationObservation {
    const observation = this.qualificationObservations.get(attemptId);
    this.qualificationObservations.delete(attemptId);
    if (observation === undefined) {
      throw new Error("knowledge answer qualification observation is absent");
    }
    return observation;
  }

  private build(request: GroundedAnswerGenerationRequest) {
    return buildSubscriptionRuntimeKnowledgeAnswerRequest(request, this.requestOptions);
  }

  private async executeObserved(
    attemptId: string,
    callOrdinal: KnowledgeAnswerProviderExchangeIdentity["callOrdinal"],
    runtimeRequest: SubscriptionRuntimeAgentTaskRequest,
    options: { readonly signal?: AbortSignal },
    capture: { readonly exchanges: KnowledgeAnswerProviderExchange[];
      readonly executionState: { providerBytesSent: boolean } },
  ): Promise<SubscriptionRuntimeTaskResult> {
    if (this.#wireObservation === undefined) {
      return await this.#transport.execute(runtimeRequest, options);
    }
    const identity = providerExchangeIdentity(attemptId, callOrdinal, runtimeRequest,
      this.#qualificationExecutionBinding);
    try {
      return await this.#wireObservation.execute(identity, runtimeRequest, options);
    } finally {
      const captured = this.#wireObservation.take(identity);
      capture.executionState.providerBytesSent ||= captured.requestBytes !== null;
      if (captured.requestBytes !== null && captured.responseBytes !== null) {
        capture.exchanges.push(Object.freeze({ identity, requestBytes: captured.requestBytes,
          responseBytes: captured.responseBytes }));
      }
    }
  }

  /** Provider-free exact request preparation used by qualification preflight. */
  public prepare(request: GroundedAnswerGenerationRequest): PreparedKnowledgeAnswerRuntimeRequest {
    const runtimeRequest = this.build(request);
    const exactInput = measureKnowledgeAnswerModelInputs(runtimeRequest);
    assertKnowledgeAnswerInputBound(exactInput);
    return Object.freeze({ exactInput, modelInputs: Object.freeze({
      original: inputSurface(runtimeRequest),
      repair: inputSurface(providerOutputRepairRequest(runtimeRequest)) }),
    request: runtimeRequest });
  }

  private recordQualificationObservation(attemptId: string,
    exchanges: readonly KnowledgeAnswerProviderExchange[],
    outcomeCertain: boolean,
    providerBytesSent = exchanges.length > 0): void {
    if (this.qualificationObservations.has(attemptId)) {
      throw new Error("knowledge answer qualification observation is duplicated");
    }
    const responseBytes = exchanges.reduce((total, exchange) =>
      total + exchange.responseBytes.byteLength, 0);
    const receiptBytes = Buffer.concat(exchanges.map(({ responseBytes: value }) =>
      Buffer.from(value)));
    this.qualificationObservations.set(attemptId, Object.freeze({ attemptId,
      exchanges: Object.freeze({ original: exchanges[0] ?? Object.freeze({
        identity: Object.freeze({ attemptId, callOrdinal: "original", purpose: "",
          runId: "", runtimeProfile: Object.freeze({ maxOutputTokens: 0, model: "",
            outputSchemaName: "", policyVersion: "", reasoningEffort: "" }) }),
        requestBytes: new Uint8Array(), responseBytes: new Uint8Array() }),
      repair: exchanges[1] ?? null }), outcomeCertain,
      providerBytesSent, responseBytes,
      runtimeReceiptSha256: createHash("sha256").update(receiptBytes).digest("hex") }));
  }
}

function providerExchangeIdentity(
  attemptId: string,
  callOrdinal: KnowledgeAnswerProviderExchangeIdentity["callOrdinal"],
  request: SubscriptionRuntimeAgentTaskRequest,
  executionBinding?: KnowledgeAnswerQualificationExecutionBinding,
): KnowledgeAnswerProviderExchangeIdentity {
  return Object.freeze({ attemptId, callOrdinal,
    ...(executionBinding === undefined ? {} : { executionBinding }),
    purpose: request.context.purpose,
    runId: request.runId, runtimeProfile: Object.freeze({
      maxOutputTokens: request.task.controls.maxOutputTokens,
      model: request.task.controls.model,
      outputSchemaName: request.task.controls.outputSchemaName,
      policyVersion: request.task.metadata.policyVersion,
      reasoningEffort: request.task.controls.reasoningEffort,
    }) });
}

function providerOutputRepairRequest(
  request: ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest>,
): ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest> {
  const runId = stableSubscriptionRuntimeId(
    "knowledge-answer-provider-output-repair",
    request.runId,
  );
  return {
    ...request,
    context: {
      ...request.context,
      correlationId: runId,
    },
    runId,
    task: {
      ...request.task,
      systemPrompt: [
        request.task.systemPrompt,
        "A previous generation failed strict output validation. Regenerate once from the original supplied question and evidence and obey every schema bound exactly.",
        "In particular, claims=[] with status=answered is forbidden. Decide answerability before emitting claims: for an answerable question populate claims with at least one concise supported claim and its direct evidenceIds, then emit status=answered; otherwise keep claims=[] and emit insufficient_evidence or not_a_question.",
      ].join(" "),
    },
  };
}

function inputSurface(
  request: ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest>,
): string {
  return [
    request.task.systemPrompt,
    request.task.prompt,
    JSON.stringify(request.task.controls.outputSchema),
  ].join("\n");
}

export function measureKnowledgeAnswerModelInputs(
  request: ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest>,
): KnowledgeAnswerExactInputMeasurement {
  const original = measureInputSurface(request);
  const repair = measureInputSurface(providerOutputRepairRequest(request));
  return Object.freeze({
    maximumModelInputBytes: Math.max(original.fullInputBytes, repair.fullInputBytes),
    original,
    repair,
  });
}

function measureInputSurface(
  request: ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest>,
): KnowledgeAnswerModelInputSurfaceMeasurement {
  const encoder = new TextEncoder();
  const outputSchema = JSON.stringify(request.task.controls.outputSchema);
  return Object.freeze({
    fullInputBytes: encoder.encode(inputSurface(request)).byteLength,
    outputSchemaBytes: encoder.encode(outputSchema).byteLength,
    systemPromptBytes: encoder.encode(request.task.systemPrompt).byteLength,
    userPromptBytes: encoder.encode(request.task.prompt).byteLength,
  });
}

function assertKnowledgeAnswerInputBound(
  measurement: KnowledgeAnswerExactInputMeasurement,
): void {
  if (
    measurement.original.fullInputBytes > knowledgeAnswerMaximumModelInputBytes ||
    measurement.repair.fullInputBytes > knowledgeAnswerMaximumModelInputBytes
  ) {
    throw new Error("knowledge answer model input exceeds the qualified 16000-byte bound");
  }
}

function invalidOutput(code: string): GroundedAnswerGenerationResult {
  return { code, retryable: false, status: "failed" };
}

function validateRequestOptions(
  options: SubscriptionRuntimeGroundedAnswerAdapterOptions,
): KnowledgeAnswerRequestOptions {
  const isolatedCwd = options.isolatedCwd ?? defaultIsolatedCwd;
  const maxOutputTokens = options.maxOutputTokens ??
    subscriptionRuntimeKnowledgeAnswerMaxOutputTokens;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (
    !isolatedCwd.startsWith("/") ||
    isolatedCwd.includes("\0") ||
    maxOutputTokens !== subscriptionRuntimeKnowledgeAnswerMaxOutputTokens ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 300_000
  ) {
    throw new Error("knowledge answer options conflict with the pinned runtime profile");
  }
  return {
    isolatedCwd,
    maxOutputTokens,
    ...(options.speakerAliases === undefined
      ? {}
      : { speakerAliases: Object.freeze({ ...options.speakerAliases }) }),
    timeoutMs,
  };
}
