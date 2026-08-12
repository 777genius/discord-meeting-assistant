import type {
  HostedCampaignBarrierAction,
  HostedCampaignChildHandle,
  HostedCampaignPorts,
  HostedCampaignThresholds,
} from "./hosted-campaign-coordinator.js";

export async function stopEveryChild(
  handles: readonly HostedCampaignChildHandle[], ports: HostedCampaignPorts,
): Promise<void> {
  const results = await Promise.allSettled(handles.map(async (handle) => ports.stopChild(handle)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(({ reason }) => reason instanceof Error
      ? reason : new Error("Failed to stop hosted campaign child", { cause: reason }));
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to stop every hosted campaign child");
  }
}

export function validateActionEvidence(
  action: HostedCampaignBarrierAction, evidence: unknown, thresholds: HostedCampaignThresholds,
): void {
  if (typeof evidence !== "object" || evidence === null) {
    throw new Error(`Missing ${action.kind} evidence`);
  }
  const value = evidence as Record<string, unknown>;
  validateProvenanceEvidence(action, value);
  validateCaptureEvidence(action, value);
  validateAnswerLatencyEvidence(action, value, thresholds);
  validateServiceLevelEvidence(action, value);
  validateRunEvidence(action, value);
  validateFiniteCompletionEvidence(action, value);
}

function validateProvenanceEvidence(
  action: HostedCampaignBarrierAction, value: Readonly<Record<string, unknown>>,
): void {
  if ((action.kind === "provenance-before" || action.kind === "provenance-after")
    && (typeof value.digestSha256 !== "string" || !/^[a-f\d]{64}$/u.test(value.digestSha256))) {
    throw new Error(`${action.kind} digest evidence is invalid`);
  }
}

function validateCaptureEvidence(
  action: HostedCampaignBarrierAction, value: Readonly<Record<string, unknown>>,
): void {
  if (action.kind === "capture-retained" && (value.retained !== true || value.ordinal !== action.ordinal)) {
    throw new Error(`Capture ${action.ordinal} retained evidence is invalid`);
  }
}

function validateAnswerLatencyEvidence(
  action: HostedCampaignBarrierAction,
  value: Readonly<Record<string, unknown>>,
  thresholds: HostedCampaignThresholds,
): void {
  if (action.kind === "answer-first-packet") {
    const latency = value.answerLatencyMilliseconds;
    if (!Number.isSafeInteger(latency) || (latency as number) < 0
      || (latency as number) > thresholds.answerFirstPacketMilliseconds) {
      throw new Error(`Answer first-packet SLA failed: ${String(latency)}ms`);
    }
  }
}

function validateServiceLevelEvidence(
  action: HostedCampaignBarrierAction, value: Readonly<Record<string, unknown>>,
): void {
  if (action.kind === "service-levels-ready" && (value.measurementCount !== 3
    || typeof value.outputPath !== "string" || !value.outputPath.startsWith("/")
    || typeof value.recordingId !== "string" || value.recordingId.length === 0
    || typeof value.runId !== "string" || value.runId.length === 0)) {
    throw new Error("Hosted service-level evidence is invalid");
  }
  if (action.kind === "service-level-sources-ready" && (value.sourcesReady !== true
    || typeof value.outputPath !== "string" || !value.outputPath.startsWith("/")
    || typeof value.runId !== "string" || value.runId.length === 0)) {
    throw new Error("Hosted service-level source evidence is invalid");
  }
}

function validateRunEvidence(
  action: HostedCampaignBarrierAction, value: Readonly<Record<string, unknown>>,
): void {
  if (action.kind === "run-verified" && (value.verified !== true
    || value.ordinal !== action.ordinal || value.runId !== action.runId)) {
    throw new Error(`Run ${action.ordinal} verification evidence is invalid`);
  }
}

function validateFiniteCompletionEvidence(
  action: HostedCampaignBarrierAction, value: Readonly<Record<string, unknown>>,
): void {
  if ((action.kind === "actor-completed" || action.kind === "conversation-observer-completed"
    || action.kind === "playback-link-seen" || action.kind === "recording-ready" || action.kind === "replay-attestation-ready"
    || action.kind === "supplemental-completed")
    && (value.completed !== true || value.ordinal !== action.ordinal || value.runId !== action.runId)) {
    throw new Error(`${action.kind} evidence is invalid for run ${action.runId}`);
  }
}
