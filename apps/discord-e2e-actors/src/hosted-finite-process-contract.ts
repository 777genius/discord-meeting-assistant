import type {
  CampaignScenario,
  HostedCampaignCompletionAction,
  HostedCampaignExecutableSpec,
} from "./hosted-campaign-coordinator.js";

export type HostedFiniteProcessCompletion =
  | { readonly action: Extract<HostedCampaignCompletionAction, { readonly kind: "actor-completed" }>; readonly kind: "actor"; readonly outputPath: string; readonly runId: string; readonly scenario: CampaignScenario }
  | { readonly action: Extract<HostedCampaignCompletionAction, { readonly kind: "conversation-observer-completed" }>; readonly kind: "conversation-observer"; readonly outputPaths: readonly string[]; readonly runId: string }
  | { readonly action: Extract<HostedCampaignCompletionAction, { readonly kind: "playback-link-seen" }>; readonly kind: "playback-link-observer"; readonly outputPath: string; readonly recordingId?: string; readonly runId: string }
  | { readonly action: Extract<HostedCampaignCompletionAction, { readonly kind: "recording-ready" }>; readonly kind: "recording-ready"; readonly outputPath: string; readonly runId: string }
  | { readonly action: Extract<HostedCampaignCompletionAction, { readonly kind: "replay-attestation-ready" }>; readonly fixtureManifestPath: string; readonly kind: "replay-attestation-publisher"; readonly recordingId?: string; readonly remoteAttestationPath: string; readonly runId: string }
  | { readonly action: Extract<HostedCampaignCompletionAction, { readonly kind: "supplemental-completed" }>; readonly kind: "supplemental-player"; readonly outputPath: string; readonly runId: string };

export function validateHostedFiniteProcessContract(
  child: HostedCampaignExecutableSpec,
  completion: HostedFiniteProcessCompletion,
): void {
  if (completion.action.runId !== completion.runId) {
    throw new Error(`Hosted finite child ${child.childId} completion action is not bound to its run`);
  }
  if (!hasRequiredRecordingIdentity(child, completion)) {
    throw new Error(`Hosted finite child ${child.childId} has no recording identity binding`);
  }
  if (JSON.stringify(expectedEnvironmentValues(child, completion)) !== JSON.stringify(declaredValues(child, completion))) {
    throw new Error(`Hosted finite child ${child.childId} completion is not bound to its environment`);
  }
}

function hasRequiredRecordingIdentity(
  child: HostedCampaignExecutableSpec,
  completion: HostedFiniteProcessCompletion,
): boolean {
  if (completion.kind === "playback-link-observer" && completion.recordingId === undefined) {
    return hasBinding(child, "DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID", "recordingId")
      || child.environment.DISCORD_E2E_PLAYBACK_LINK_READY_RECEIPT_INPUT !== undefined;
  }
  return completion.kind !== "replay-attestation-publisher" || completion.recordingId !== undefined
    || hasBinding(child, "DISCORD_E2E_REPLAY_RECORDING_ID", "recordingId");
}

function expectedEnvironmentValues(
  child: HostedCampaignExecutableSpec,
  completion: HostedFiniteProcessCompletion,
): readonly (string | undefined)[] {
  const environment = child.environment;
  switch (completion.kind) {
    case "actor": return [environment.DISCORD_E2E_ACTOR_RUN_OUTPUT, environment.DISCORD_E2E_RUN_ID, environment.DISCORD_E2E_SCENARIO];
    case "conversation-observer": return [environment.DISCORD_E2E_CONVERSATION_VOICE_RUN_ID];
    case "playback-link-observer": return [environment.DISCORD_E2E_PLAYBACK_LINK_OUTPUT,
      environment.DISCORD_E2E_PLAYBACK_LINK_RUN_ID, environment.DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID];
    case "recording-ready": return [environment.DISCORD_E2E_READY_RECEIPT_OUTPUT, environment.DISCORD_E2E_RUN_ID];
    case "replay-attestation-publisher": return [environment.DISCORD_E2E_REPLAY_FIXTURE_MANIFEST,
      environment.DISCORD_E2E_REPLAY_RECORDING_ID, environment.DISCORD_E2E_REPLAY_REMOTE_ATTESTATION_FILE,
      environment.DISCORD_E2E_REPLAY_RUN_ID];
    case "supplemental-player": return [environment.DISCORD_E2E_SUPPLEMENTAL_EVIDENCE_OUTPUT,
      environment.DISCORD_E2E_SUPPLEMENTAL_RUN_ID];
  }
}

function declaredValues(
  child: HostedCampaignExecutableSpec,
  completion: HostedFiniteProcessCompletion,
): readonly (string | undefined)[] {
  switch (completion.kind) {
    case "actor": return [completion.outputPath, completion.runId, completion.scenario];
    case "conversation-observer": return [completion.runId];
    case "playback-link-observer": return [completion.outputPath, completion.runId,
      completion.recordingId ?? child.environment.DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID];
    case "replay-attestation-publisher": return [completion.fixtureManifestPath,
      completion.recordingId ?? child.environment.DISCORD_E2E_REPLAY_RECORDING_ID,
      completion.remoteAttestationPath, completion.runId];
    case "recording-ready":
    case "supplemental-player": return [completion.outputPath, completion.runId];
  }
}

function hasBinding(
  child: HostedCampaignExecutableSpec, name: string, field: "meetingId" | "recordingId",
): boolean {
  return child.environmentBindings?.some((binding) => binding.name === name
    && binding.valueFrom.field === field && binding.valueFrom.actionRef.action.kind === "recording-ready") === true;
}
