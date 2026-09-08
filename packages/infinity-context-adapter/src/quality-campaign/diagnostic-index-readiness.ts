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
  const capability = (value as { context?: { retrieval?: Record<string, unknown> } } | null)?.context?.retrieval;
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
  const lanes = capability.provider_lanes as Array<Record<string, unknown>>;
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
