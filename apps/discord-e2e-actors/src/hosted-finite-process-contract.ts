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
  | { readonly action: Extract<HostedCampaignCompletionAction, { readonly kind: "supplemental-completed" }>; readonly kind: "supplemental-player"; readonly outputPath: string; readonly runId: string };

export function validateHostedFiniteProcessContract(
  child: HostedCampaignExecutableSpec,
  completion: HostedFiniteProcessCompletion,
): void {
  const environment = child.environment;
  if (completion.action.runId !== completion.runId) {
    throw new Error(`Hosted finite child ${child.childId} completion action is not bound to its run`);
  }
  if (completion.kind === "playback-link-observer" && completion.recordingId === undefined
    && !hasBinding(child, "DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID", "recordingId")) {
    throw new Error(`Hosted finite child ${child.childId} has no recording identity binding`);
  }
  const expected = completion.kind === "actor"
    ? [environment.DISCORD_E2E_ACTOR_RUN_OUTPUT, environment.DISCORD_E2E_RUN_ID, environment.DISCORD_E2E_SCENARIO]
    : completion.kind === "conversation-observer"
      ? [environment.DISCORD_E2E_CONVERSATION_VOICE_RUN_ID]
      : completion.kind === "playback-link-observer"
        ? [environment.DISCORD_E2E_PLAYBACK_LINK_OUTPUT, environment.DISCORD_E2E_PLAYBACK_LINK_RUN_ID,
          environment.DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID]
        : completion.kind === "recording-ready"
          ? [environment.DISCORD_E2E_READY_RECEIPT_OUTPUT, environment.DISCORD_E2E_RUN_ID]
          : [environment.DISCORD_E2E_SUPPLEMENTAL_EVIDENCE_OUTPUT, environment.DISCORD_E2E_SUPPLEMENTAL_RUN_ID];
  const declared = completion.kind === "actor"
    ? [completion.outputPath, completion.runId, completion.scenario]
    : completion.kind === "conversation-observer"
      ? [completion.runId]
      : completion.kind === "playback-link-observer"
        ? [completion.outputPath, completion.runId,
          completion.recordingId ?? environment.DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID]
        : [completion.outputPath, completion.runId];
  if (JSON.stringify(expected) !== JSON.stringify(declared)) {
    throw new Error(`Hosted finite child ${child.childId} completion is not bound to its environment`);
  }
}

function hasBinding(
  child: HostedCampaignExecutableSpec, name: string, field: "meetingId" | "recordingId",
): boolean {
  return child.environmentBindings?.some((binding) => binding.name === name
    && binding.valueFrom.field === field && binding.valueFrom.actionRef.action.kind === "recording-ready") === true;
}
