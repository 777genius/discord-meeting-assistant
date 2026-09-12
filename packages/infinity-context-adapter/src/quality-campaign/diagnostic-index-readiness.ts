import * as sdk from "@infinity-context/sdk";
import type { DiagnosticV3ProviderBinding } from "./diagnostic-manifest.js";
import { randomUUID } from "node:crypto";
import { FetchTransport, InfinityContextClient, InfinityContextError, assertRetrievalCapability,
  type HttpTransport } from "@infinity-context/sdk";
import type { FocusedLocatorRetrievalV2ProviderBinding } from "@discord-meeting/meeting-core/meeting-knowledge";
import { retrievalV2CapabilityFingerprint } from "../infinity-context-retrieval-v2.js";
import type { DiagnosticCustody } from "./diagnostic-custody.js";

const PREPARATION_TIMEOUT_MS = 600_000;
type ProbeCode = "ready" | "provider_unready" | "foreign_binding" | "invalid_capability" | "request_failed" | "request_timeout";
export interface DiagnosticIndexPreparation {
  readonly status: "ready" | "blocked";
  readonly reason: "diagnostic_index_readiness_timeout" | "diagnostic_index_readiness_failed" | null;
  readonly elapsedMs: number;
  readonly probes: number;
  readonly lastProbeCode: ProbeCode;
}
export class DiagnosticIndexReadinessError extends Error {
  public constructor(readonly preparation: DiagnosticIndexPreparation) {
    super(preparation.reason ?? "diagnostic_index_readiness_failed");
  }
}

/** SDK-only read barrier. An applied process mutation is not a serving readiness receipt. */
export async function awaitDiagnosticIndexReadiness(input: {
  readonly baseUrl: string;
  readonly token: string;
  readonly binding: FocusedLocatorRetrievalV2ProviderBinding;
  readonly custody: DiagnosticCustody;
  /** Synthetic tests still traverse the official SDK. */
  readonly transport?: HttpTransport;
}): Promise<DiagnosticIndexPreparation> {
  const started = performance.now(), deadline = started + PREPARATION_TIMEOUT_MS;
  const observer = new ReadinessTransport(input.transport ?? new FetchTransport(), input.binding);
  const client = new InfinityContextClient({ baseUrl: input.baseUrl, token: input.token,
    retryPolicy: { maxAttempts: 1 }, timeoutMs: 2_000, transport: observer });
  let probes = 0, lastProbeCode: ProbeCode = "request_failed";
  let ready = false, timedOut = false;
  while (performance.now() < deadline) {
    probes += 1;
    lastProbeCode = await probe(client, observer, input.binding,
      Math.max(1, Math.min(2_000, Math.floor(deadline - performance.now()))));
    if (performance.now() >= deadline) {timedOut = true; break;}
    if (lastProbeCode === "ready") {ready = true; break;}
    if (lastProbeCode !== "provider_unready") {break;}
    await new Promise<void>(resolve => {setTimeout(resolve,
      Math.min(1_000, Math.max(0, deadline - performance.now())));});
  }
  timedOut ||= !ready && performance.now() >= deadline;
  const preparation: DiagnosticIndexPreparation = { status: ready ? "ready" : "blocked",
    reason: ready ? null : timedOut ? "diagnostic_index_readiness_timeout" : "diagnostic_index_readiness_failed",
    elapsedMs: Math.max(0, Math.ceil(performance.now() - started)), probes, lastProbeCode };
  // Each invocation checks live health again. Prior receipts are evidence, never cached authority.
  await input.custody.retain(`index-preparation-${randomUUID()}`, preparation);
  if (!ready) {throw new DiagnosticIndexReadinessError(preparation);}
  return preparation;
}

async function probe(client: InfinityContextClient, observer: ReadinessTransport,
  binding: FocusedLocatorRetrievalV2ProviderBinding, timeoutMs: number): Promise<ProbeCode> {
  observer.reset();
  try {
    const capabilities = await client.system.capabilities({ timeoutMs });
    const capability = assertRetrievalCapability(capabilities, {
      capabilityFingerprint: binding.capabilityFingerprint, profileId: binding.profileId,
      requiredProviderLanes: binding.requiredProviderLanes });
    if (capability.service_revision !== binding.serviceRevision ||
      capability.index_profile_digest !== binding.indexProfileDigest ||
      capability.capability_fingerprint !== retrievalV2CapabilityFingerprint(
        capability as unknown as Readonly<Record<string, unknown>>)) {return "foreign_binding";}
    return "ready";
  } catch (error) {
    if (observer.observation === "foreign_binding") {return "foreign_binding";}
    if (error instanceof InfinityContextError &&
      error.code === "memory.context_retrieval_capability_mismatch") {return observer.observation;}
    return error instanceof InfinityContextError && error.code === "memory.request_timeout"
      ? "request_timeout" : "request_failed";
  }
}

/** Observe only public identity/health while SDK rejects an unqualified projection.
 * No request, token, response body or private payload is retained. */
class ReadinessTransport implements HttpTransport {
  public observation: Exclude<ProbeCode, "ready" | "request_failed" | "request_timeout"> = "invalid_capability";
  public constructor(readonly delegate: HttpTransport,
    readonly binding: FocusedLocatorRetrievalV2ProviderBinding) {}
  public reset(): void {this.observation = "invalid_capability";}
  public async send(request: Parameters<HttpTransport["send"]>[0]) {
    const response = await this.delegate.send(request);
    if (response.status === 200) {
      try {
        const bytes = typeof response.body === "string" ? Buffer.from(response.body) : response.body;
        if (bytes.byteLength <= 262_144) {
          this.observation = observe(JSON.parse(Buffer.from(bytes).toString("utf8")), this.binding);
        }
      } catch {this.observation = "invalid_capability";}
    }
    return response;
  }
}

function observe(value: unknown, binding: FocusedLocatorRetrievalV2ProviderBinding):
  ReadinessTransport["observation"] {
  const capability = (value as { context?: { retrieval?: Record<string, unknown> | null } } | null)?.context?.retrieval;
  if (capability === undefined || capability === null) {return "invalid_capability";}
  if (capability.profile_id !== binding.profileId ||
    capability.service_revision !== binding.serviceRevision ||
    capability.index_profile_digest !== binding.indexProfileDigest ||
    capability.contract_version !== binding.contractVersion ||
    capability.ranking_policy !== binding.rankingPolicy ||
    JSON.stringify(capability.required_provider_lanes) !== JSON.stringify(binding.requiredProviderLanes)) {
    return "foreign_binding";
  }
  if (capability.capability_fingerprint !== retrievalV2CapabilityFingerprint(capability) ||
    !Array.isArray(capability.provider_lanes)) {return "invalid_capability";}
  const lanes = capability.provider_lanes as Array<Record<string, unknown> | null>;
  // Only required-lane health may differ from the exact frozen capability.
  // Normalization is for retry classification only, never passed to the SDK or accepted as ready.
  const restoredHealth = { ...capability, provider_lanes: lanes.map(lane =>
    lane !== null && lane.required === true ? { ...lane, healthy: true, profile_qualified: true } : lane) };
  if (retrievalV2CapabilityFingerprint(restoredHealth) !== binding.capabilityFingerprint) {
    return "invalid_capability";
  }
  // This observation only permits another read; full SDK validation is mandatory for success.
  return lanes.some(lane => lane !== null && binding.requiredProviderLanes.includes(String(lane.provider_id)) &&
    lane.required === true && (lane.healthy === false || lane.profile_qualified === false))
    ? "provider_unready" : "invalid_capability";
}

/** V3-only barrier. Requires the authentic SDK V3 public surface; never falls back to V2. */
export async function awaitDiagnosticIndexReadinessV3(input: {
  readonly baseUrl: string;
  readonly token: string;
  readonly binding: DiagnosticV3ProviderBinding;
  readonly custody: Pick<DiagnosticCustody, "retain">;
  readonly transport?: HttpTransport;
}): Promise<DiagnosticIndexPreparation> {
  const started = performance.now(), deadline = started + PREPARATION_TIMEOUT_MS;
  const binding = Object.freeze({ ...input.binding,
    requiredProviderLanes: Object.freeze([...input.binding.requiredProviderLanes]) });
  const observer = new V3ReadinessTransport(input.transport ?? new FetchTransport(), binding);
  const client = new InfinityContextClient({ baseUrl: input.baseUrl, token: input.token,
    retryPolicy: { maxAttempts: 1 }, timeoutMs: 2_000, transport: observer });
  let probes = 0, lastProbeCode: ProbeCode = "invalid_capability", ready = false;
  const validBinding = binding.contractVersion === "context-retrieval.v3" &&
    binding.rankingPolicy === sdk.CONTEXT_RETRIEVAL_RANKING_POLICY &&
    /^[a-f0-9]{64}$/u.test(binding.indexProfileDigest) &&
    /^[a-f0-9]{64}$/u.test(binding.capabilityFingerprint) &&
    /^[a-f0-9]{40}$/u.test(binding.serviceRevision) &&
    binding.profileId === `locator-v2-full-${binding.indexProfileDigest}` &&
    JSON.stringify(binding.requiredProviderLanes) === JSON.stringify(["postgres_keyword", "qdrant_dense"]);
  while (validBinding && performance.now() < deadline) {
    probes += 1;
    observer.reset();
    try {
      const capability = await client.context.retrievalV3Capability({
        timeoutMs: Math.max(1, Math.min(2_000, Math.floor(deadline - performance.now()))) });
      lastProbeCode = v3PinsMatch(capability, binding) &&
        capability.capability_fingerprint === binding.capabilityFingerprint ? "ready" : "foreign_binding";
    } catch (error) {
      lastProbeCode = error instanceof InfinityContextError &&
        error.code === "memory.context_retrieval_capability_mismatch" ? observer.observation :
        error instanceof InfinityContextError &&
        ["memory.request_timeout", "memory.context_retrieval_deadline_exceeded"].includes(error.code)
          ? "request_timeout" : "request_failed";
    }
    if (performance.now() >= deadline) {break;}
    if (lastProbeCode === "ready") {ready = true; break;}
    if (lastProbeCode !== "provider_unready") {break;}
    await new Promise<void>(resolve => {setTimeout(resolve,
      Math.min(1_000, Math.max(0, deadline - performance.now())));});
  }
  const preparation: DiagnosticIndexPreparation = { status: ready ? "ready" : "blocked",
    reason: ready ? null : performance.now() >= deadline ? "diagnostic_index_readiness_timeout"
      : "diagnostic_index_readiness_failed",
    elapsedMs: Math.max(0, Math.ceil(performance.now() - started)), probes, lastProbeCode };
  await input.custody.retain(`index-preparation-${randomUUID()}`, preparation);
  if (!ready) {throw new DiagnosticIndexReadinessError(preparation);}
  return preparation;
}

function v3PinsMatch(capability: sdk.RetrievalV3Capability, binding: DiagnosticV3ProviderBinding): boolean {
  return capability.contract_version === binding.contractVersion &&
    capability.endpoint === "/v1/context/retrieve-v3" &&
    capability.service_revision === binding.serviceRevision &&
    capability.index_profile_digest === binding.indexProfileDigest &&
    capability.profile_id === binding.profileId && capability.ranking_policy === binding.rankingPolicy &&
    JSON.stringify(capability.required_provider_lanes) === JSON.stringify(binding.requiredProviderLanes);
}

class V3ReadinessTransport implements HttpTransport {
  public observation: ProbeCode = "invalid_capability";
  public reset(): void {this.observation = "invalid_capability";}
  public constructor(readonly delegate: HttpTransport, readonly binding: DiagnosticV3ProviderBinding) {}
  public async send(request: Parameters<HttpTransport["send"]>[0]) {
    const response = await this.delegate.send(request);
    if (response.status !== 200) {return response;}
    try {
      const bytes = typeof response.body === "string" ? Buffer.from(response.body) : response.body;
      if (bytes.byteLength > 65_536) {return response;}
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as sdk.RetrievalV3Capability;
      // This projection permits only retry classification. The original bytes always go to the SDK,
      // whose strict JSON failure (including duplicate keys) cannot authorize another probe.
      const restored = sdk.decodeRetrievalV3Capability({ ...value,
        provider_lanes: value.provider_lanes.map(lane => lane.required === true
          ? { ...lane, healthy: true, profile_qualified: true } : lane) });
      if (!v3PinsMatch(restored, this.binding)) {this.observation = "foreign_binding";}
      else if (await sdk.retrievalCapabilityFingerprint(value) === value.capability_fingerprint &&
        await sdk.retrievalCapabilityFingerprint(restored) === this.binding.capabilityFingerprint &&
        value.provider_lanes.some(lane => lane.required === true &&
          (lane.healthy === false || lane.profile_qualified === false)) &&
        value.provider_lanes.every(lane => typeof lane.healthy === "boolean" &&
          typeof lane.profile_qualified === "boolean")) {this.observation = "provider_unready";}
    } catch {this.observation = "invalid_capability";}
    return response;
  }
}
