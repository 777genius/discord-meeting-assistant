import type {
  HostedCampaignBarrierAction,
  HostedCampaignChildHandle,
  HostedCampaignInput,
  HostedCampaignPorts,
  HostedCampaignStartPoint,
  HostedCampaignThresholds,
} from "./hosted-campaign-coordinator.js";

export function campaignActions(input: HostedCampaignInput): readonly HostedCampaignBarrierAction[] {
  const [sequential, overlap, reconnect] = input.runs;
  return [
    { kind: "provenance-before" },
    { kind: "observer-subscribed" },
    { kind: "run-verified", ordinal: sequential!.ordinal, runId: sequential!.runId },
    { kind: "run-verified", ordinal: overlap!.ordinal, runId: overlap!.runId },
    ...Array.from({ length: 4 }, (_, index) => ({
      kind: "capture-retained" as const, ordinal: index + 1,
    })),
    { kind: "reconnect-left" },
    { kind: "reconnect-ready" },
    { kind: "answer-intent" },
    { kind: "answer-observer-ready" },
    { kind: "answer-first-packet" },
    { kind: "capture-retained", ordinal: 5 },
    { kind: "capture-retained", ordinal: 6 },
    { kind: "service-levels-ready" },
    { kind: "run-verified", ordinal: reconnect!.ordinal, runId: reconnect!.runId },
    { kind: "provenance-after" },
    { kind: "campaign-verified" },
  ];
}

export function actionIdentity(action: HostedCampaignBarrierAction): string {
  if (action.kind === "capture-retained") {
    return `${action.kind}:${action.ordinal}`;
  }
  if (action.kind === "run-verified") {
    return `${action.kind}:${action.ordinal}:${action.runId}`;
  }
  return action.kind;
}

export function startPointIdentity(startPoint: HostedCampaignStartPoint): string {
  return startPoint.kind === "campaign" ? "campaign" : `barrier:${actionIdentity(startPoint.action)}`;
}

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
  if ((action.kind === "provenance-before" || action.kind === "provenance-after")
    && (typeof value.digestSha256 !== "string" || !/^[a-f\d]{64}$/u.test(value.digestSha256))) {
    throw new Error(`${action.kind} digest evidence is invalid`);
  }
  if (action.kind === "capture-retained" && (value.retained !== true || value.ordinal !== action.ordinal)) {
    throw new Error(`Capture ${action.ordinal} retained evidence is invalid`);
  }
  if (action.kind === "answer-first-packet") {
    const latency = value.answerLatencyMilliseconds;
    if (!Number.isSafeInteger(latency) || (latency as number) < 0
      || (latency as number) > thresholds.answerFirstPacketMilliseconds) {
      throw new Error(`Answer first-packet SLA failed: ${String(latency)}ms`);
    }
  }
  if (action.kind === "service-levels-ready" && (value.measurementCount !== 3
    || typeof value.outputPath !== "string" || !value.outputPath.startsWith("/")
    || typeof value.recordingId !== "string" || value.recordingId.length === 0
    || typeof value.runId !== "string" || value.runId.length === 0)) {
    throw new Error("Hosted service-level evidence is invalid");
  }
  if (action.kind === "run-verified" && (value.verified !== true
    || value.ordinal !== action.ordinal || value.runId !== action.runId)) {
    throw new Error(`Run ${action.ordinal} verification evidence is invalid`);
  }
  if ((action.kind === "actor-completed" || action.kind === "conversation-observer-completed"
    || action.kind === "playback-link-seen" || action.kind === "recording-ready"
    || action.kind === "supplemental-completed")
    && (value.completed !== true || value.ordinal !== action.ordinal || value.runId !== action.runId)) {
    throw new Error(`${action.kind} evidence is invalid for run ${action.runId}`);
  }
}
