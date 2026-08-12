import type {
  HostedCampaignActionReference,
  HostedCampaignExecutableSpec,
  HostedCampaignRun,
} from "./hosted-campaign-coordinator.js";

export function validateHostedSupplementalPlaybackAdmission(
  child: HostedCampaignExecutableSpec,
  reconnectRun: HostedCampaignRun | undefined,
  orderedActions: readonly HostedCampaignActionReference[],
): void {
  if (child.entrypoint !== "supplemental-player") {
    return;
  }
  if (reconnectRun === undefined || child.completion?.kind !== "supplemental-player"
    || child.completion.runId !== reconnectRun.runId
    || child.completion.action.ordinal !== reconnectRun.ordinal
    || child.completion.action.runId !== reconnectRun.runId) {
    throw new Error(
      `Hosted supplemental player ${child.childId} must complete in the reconnect run`,
    );
  }
  const observerReady: HostedCampaignActionReference = {
    action: { kind: "observer-subscribed" },
    ordinal: reconnectRun.ordinal,
    runId: reconnectRun.runId,
  };
  const recordingReady: HostedCampaignActionReference = {
    action: { kind: "recording-ready", ordinal: reconnectRun.ordinal, runId: reconnectRun.runId },
    ordinal: reconnectRun.ordinal,
    runId: reconnectRun.runId,
  };
  if (!hasReference(child.requires, observerReady) || !hasReference(child.requires, recordingReady)) {
    throw new Error(
      `Hosted supplemental player ${child.childId} requires reconnect observer and recording readiness`,
    );
  }
  if (child.startBefore.kind !== "barrier"
    || child.startBefore.ordinal !== reconnectRun.ordinal
    || child.startBefore.runId !== reconnectRun.runId) {
    throw new Error(
      `Hosted supplemental player ${child.childId} must start at a reconnect-run barrier`,
    );
  }
  const observerIndex = referenceIndex(orderedActions, observerReady);
  const recordingIndex = referenceIndex(orderedActions, recordingReady);
  const startIndex = referenceIndex(orderedActions, child.startBefore);
  if (observerIndex === -1 || recordingIndex === -1 || startIndex <= observerIndex || startIndex <= recordingIndex) {
    throw new Error(
      `Hosted supplemental player ${child.childId} must start after observer and recording readiness`,
    );
  }
}

function hasReference(
  references: readonly HostedCampaignActionReference[],
  expected: HostedCampaignActionReference,
): boolean {
  return references.some((reference) => sameReference(reference, expected));
}

function referenceIndex(
  references: readonly HostedCampaignActionReference[],
  expected: HostedCampaignActionReference,
): number {
  return references.findIndex((reference) => sameReference(reference, expected));
}

function sameReference(
  left: HostedCampaignActionReference,
  right: HostedCampaignActionReference,
): boolean {
  if (left.ordinal !== right.ordinal || left.runId !== right.runId
    || left.action.kind !== right.action.kind) {
    return false;
  }
  const leftOrdinal = "ordinal" in left.action ? left.action.ordinal : undefined;
  const rightOrdinal = "ordinal" in right.action ? right.action.ordinal : undefined;
  const leftRunId = "runId" in left.action ? left.action.runId : undefined;
  const rightRunId = "runId" in right.action ? right.action.runId : undefined;
  return leftOrdinal === rightOrdinal && leftRunId === rightRunId;
}
