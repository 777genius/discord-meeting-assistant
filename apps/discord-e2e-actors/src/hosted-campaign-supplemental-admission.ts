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
  const capture = (ordinal: 3 | 4): HostedCampaignActionReference => ({
    action: { kind: "capture-retained", ordinal }, ordinal: reconnectRun.ordinal, runId: reconnectRun.runId,
  });
  const connectionTrigger = capture(3);
  const playbackTrigger = capture(4);
  if (child.supplementalGates === undefined
    || !sameReference(child.supplementalGates.connection.trigger, connectionTrigger)
    || !sameReference(child.supplementalGates.playback.trigger, playbackTrigger)) {
    throw new Error(
      `Hosted supplemental player ${child.childId} requires capture 3 connection and capture 4 playback gates`,
    );
  }
  if (child.startBefore.kind !== "barrier"
    || child.startBefore.ordinal !== reconnectRun.ordinal
    || child.startBefore.runId !== reconnectRun.runId) {
    throw new Error(
      `Hosted supplemental player ${child.childId} must start at a reconnect-run barrier`,
    );
  }
  const connectionIndex = referenceIndex(orderedActions, connectionTrigger);
  const playbackIndex = referenceIndex(orderedActions, playbackTrigger);
  const startIndex = referenceIndex(orderedActions, child.startBefore);
  if (connectionIndex === -1 || playbackIndex === -1 || startIndex >= connectionIndex) {
    throw new Error(
      `Hosted supplemental player ${child.childId} must start before reconnect capture 3`,
    );
  }
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
