import { actionIdentity, actionReferenceIdentity, campaignActions, validateExecutionGraph } from "./hosted-campaign-execution-graph.js";
import { HOSTED_CAMPAIGN_TARGET, type HostedCampaignTarget } from "./hosted-campaign-target.js";
import {
  type HostedFiniteProcessCompletion,
  validateHostedFiniteProcessContract,
} from "./hosted-finite-process-contract.js";
import type {
  CampaignScenario,
  HostedCampaignActionReference,
  HostedCampaignBoundEnvironmentName,
  HostedCampaignExecutableCompletion,
  HostedCampaignExecutableSpec,
  HostedCampaignInput,
} from "./hosted-campaign-coordinator.js";
import { governedCampaignObservationPolicyV1Schema } from
  "./governed-private-campaign-observation-contract.js";

function assertExactTarget(target: HostedCampaignTarget): void {
  for (const [key, expected] of Object.entries(HOSTED_CAMPAIGN_TARGET)) {
    if (target[key as keyof HostedCampaignTarget] !== expected) {
      throw new Error(`Hosted campaign target mismatch for ${key}`);
    }
  }
  if (Object.keys(target).length !== Object.keys(HOSTED_CAMPAIGN_TARGET).length) {
    throw new Error("Hosted campaign target contains unsupported fields");
  }
}

export function validateHostedCampaign(input: HostedCampaignInput): void {
  assertExactTarget(input.target);
  const policy = governedCampaignObservationPolicyV1Schema.safeParse(
    input.historicalReplyObservationPolicy,
  );
  const requiresHistoricalPolicy = input.children.some(({ entrypoint }) =>
    entrypoint === "historical-reply-observer" || entrypoint === "historical-reply-preparer");
  if (requiresHistoricalPolicy && (!policy.success || policy.data.guildId !== input.target.guildId ||
    !policy.data.parentChannelIds.includes(input.target.publicationChannelId))) {
    throw new Error("Hosted campaign historical observation policy is not the compiled private target");
  }
  if (input.runs.length !== 3) {
    throw new Error("Hosted campaign requires exactly three runs");
  }
  const scenarios: readonly CampaignScenario[] = ["sequential", "overlap", "reconnect"];
  const campaignId = input.runs[0]?.campaignId;
  const runIds = new Set<string>();
  input.runs.forEach((run, index) => {
    if (run.ordinal !== index + 1 || run.scenario !== scenarios[index]) {
      throw new Error(`Hosted campaign run ${index + 1} has the wrong ordinal or scenario`);
    }
    if (run.campaignId.length === 0 || run.campaignId !== campaignId) {
      throw new Error("Hosted campaign runs must share one explicit campaignId");
    }
    if (run.runId.length === 0 || runIds.has(run.runId)) {
      throw new Error("Hosted campaign requires three unique explicit runIds");
    }
    runIds.add(run.runId);
    if (run.retainedCaptureCount !== (run.scenario === "reconnect" ? 6 : 0)) {
      throw new Error("Only the reconnect run may own exactly six retained captures");
    }
  });
  if (input.children.length === 0) {
    throw new Error("Hosted campaign requires executable children");
  }
  if (!Number.isSafeInteger(input.thresholds.answerFirstPacketMilliseconds)
    || input.thresholds.answerFirstPacketMilliseconds < 1) {
    throw new Error("Hosted campaign answer first-packet threshold must be a positive safe integer");
  }
  const childIds = new Set<string>();
  const completionActions = new Set<string>();
  for (const child of input.children) {
    validateExecutable(child, input, campaignId, childIds, completionActions);
  }
  validateExecutionGraph(input);
}

function validateExecutable(
  child: HostedCampaignExecutableSpec,
  input: HostedCampaignInput,
  campaignId: string | undefined,
  childIds: Set<string>,
  completionActions: Set<string>,
): void {
  validateChildIdentity(child, childIds);
  validateChildArguments(child);
  validateChildStartPoint(child, input);
  validateOneShotStart(child);
  if (child.completion !== undefined) {
    validateCompletion(child, child.completion, input, campaignId, completionActions);
  }
  validateCompletionSchedule(child);
  validateReleaseGate(child, input);
  validateActorGates(child);
  validateSupplementalGates(child, input, campaignId);
}

function validateActorGates(child: HostedCampaignExecutableSpec): void {
  if (child.actorGates === undefined) { return; }
  if (child.entrypoint !== "actor" || child.releaseGate === undefined || child.completion?.kind !== "actor"
    || child.completion.scenario !== "reconnect") {
    throw new Error("Only the reconnect actor may declare staged actor gates");
  }
  for (const [phase, gate] of Object.entries(child.actorGates)) {
    const environmentPhase = phase === "speakerB" ? "SPEAKER_B" : phase.toUpperCase();
    if (child.environment[`DISCORD_E2E_HOSTED_${environmentPhase}_GATE_PATH`] !== gate.path
      || child.environment[`DISCORD_E2E_HOSTED_${environmentPhase}_GATE_ARMED_PATH`] !== gate.armedPath) {
      throw new Error(`Hosted actor ${phase} gate environment mismatch`);
    }
  }
}

function validateChildIdentity(child: HostedCampaignExecutableSpec, childIds: Set<string>): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(child.childId) || childIds.has(child.childId)) {
    throw new Error(`Invalid or duplicate hosted campaign childId: ${child.childId}`);
  }
  childIds.add(child.childId);
}

function validateChildArguments(child: HostedCampaignExecutableSpec): void {
  if ((child.entrypoint === "campaign-verifier") !== (child.arguments.kind === "campaign-verifier")
    || (child.entrypoint === "evidence-verifier") !== (child.arguments.kind === "evidence-verifier")) {
    throw new Error(`Hosted campaign child ${child.childId} has arguments for the wrong entrypoint`);
  }
}

function validateChildStartPoint(child: HostedCampaignExecutableSpec, input: HostedCampaignInput): void {
  if (child.startBefore.kind !== "barrier") {return;}
  const startActionIdentity = actionReferenceIdentity(child.startBefore);
  if (!campaignActions(input).some((reference) => actionReferenceIdentity(reference) === startActionIdentity)) {
    throw new Error(`Hosted campaign child ${child.childId} has an unknown start point`);
  }
}

function validateOneShotStart(child: HostedCampaignExecutableSpec): void {
  const completion = child.completion;
  const deferredFiniteProcess = completion !== undefined && isFiniteCompletion(completion)
    && (child.releaseGate !== undefined || child.completionAfter !== undefined);
  if (completion !== undefined && child.startBefore.kind === "campaign" && !deferredFiniteProcess) {
    throw new Error(`One-shot child ${child.childId} must start only after its inputs exist`);
  }
}

function validateCompletionSchedule(child: HostedCampaignExecutableSpec): void {
  if (child.completionAfter !== undefined &&
    (child.completion === undefined || !isFiniteCompletion(child.completion))) {
    throw new Error(`Hosted campaign child ${child.childId} may schedule completion only for a finite process`);
  }
}

function validateReleaseGate(child: HostedCampaignExecutableSpec, input: HostedCampaignInput): void {
  if (child.releaseGate === undefined) {return;}
  if (child.entrypoint !== "actor") {
    throw new Error("Only an actor child may declare a hosted release gate");
  }
  if (child.environment.DISCORD_E2E_HOSTED_RELEASE_GATE_PATH !== child.releaseGate.path) {
    throw new Error(`Hosted campaign actor ${child.childId} release gate path mismatch`);
  }
  const gate = child.releaseGate;
  const releaseAction = gate.action;
  if (releaseAction.kind === "run-verified") {
    const completion = child.completion;
    if (releaseAction.ordinal !== gate.ordinal || releaseAction.runId !== gate.runId
      || completion === undefined || completion.kind !== "actor"
      || completion.action.ordinal !== gate.ordinal + 1
      || !input.runs.some(({ ordinal, runId }) => ordinal === gate.ordinal && runId === gate.runId)
      || !input.runs.some(({ ordinal, runId }) =>
        ordinal === completion.action.ordinal && runId === completion.action.runId)) {
      throw new Error(`Hosted campaign actor ${child.childId} release gate must reference the prior verified run`);
    }
  }
}

function validateSupplementalGates(
  child: HostedCampaignExecutableSpec,
  input: HostedCampaignInput,
  campaignId: string | undefined,
): void {
  if (child.supplementalGates === undefined) {return;}
  const reconnect = input.runs.find(({ scenario }) => scenario === "reconnect");
  const connection = child.supplementalGates.connection;
  const playback = child.supplementalGates.playback;
  const environment = child.environment;
  const timeoutMilliseconds = Number(environment.DISCORD_E2E_SUPPLEMENTAL_GATE_TIMEOUT_MS);
  const matchesCapture = (reference: HostedCampaignActionReference, ordinal: 3) =>
    reconnect !== undefined && reference.ordinal === reconnect.ordinal && reference.runId === reconnect.runId
    && reference.action.kind === "capture-retained" && reference.action.ordinal === ordinal;
  if (child.entrypoint !== "supplemental-player" || reconnect === undefined
    || !matchesCapture(connection.trigger, 3)
    || playback.trigger.action.kind !== "actor-scenario-playback-completed"
    || playback.trigger.ordinal !== reconnect.ordinal || playback.trigger.runId !== reconnect.runId
    || connection.path === playback.path
    || environment.DISCORD_E2E_SUPPLEMENTAL_CAMPAIGN_ID !== campaignId
    || environment.DISCORD_E2E_SUPPLEMENTAL_RUN_ID !== reconnect.runId
    || environment.DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_PATH !== connection.path
    || environment.DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_PATH !== playback.path
    || environment.DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_ARMED_PATH !== connection.armedPath
    || environment.DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_ARMED_PATH !== playback.armedPath
    || new Set([connection.path, connection.armedPath, playback.path, playback.armedPath]).size !== 4
    || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1_000
    || timeoutMilliseconds > 120_000) {
    throw new Error(`Hosted supplemental player ${child.childId} has an invalid two-phase gate contract`);
  }
}

function validateCompletion(
  child: HostedCampaignExecutableSpec,
  completion: HostedCampaignExecutableCompletion,
  input: HostedCampaignInput,
  campaignId: string | undefined,
  completionActions: Set<string>,
): void {
  if (completion.kind !== child.entrypoint) {
    throw new Error(`Hosted campaign child ${child.childId} completion does not match its entrypoint and start point`);
  }
  if (isFiniteCompletion(completion)) {
    validateFiniteCompletion(child, completion, completionActions);
    return;
  }
  validateBarrierCompletion(child, completion, input, campaignId, completionActions);
}

function validateFiniteCompletion(
  child: HostedCampaignExecutableSpec,
  completion: HostedFiniteProcessCompletion,
  completionActions: Set<string>,
): void {
  validateHostedFiniteProcessContract(child, completion);
  const identity = actionIdentity(completion.action);
  const matchingProduction = child.produces.filter(({ action, ordinal, runId }) =>
    actionIdentity(action) === identity && ordinal === completion.action.ordinal && runId === completion.action.runId
  );
  if (matchingProduction.length !== 1) {
    throw new Error(`Hosted finite child ${child.childId} must produce its exact completion action`);
  }
  if (completionActions.has(identity)) {
    throw new Error(`Hosted campaign action has multiple completion producers: ${identity}`);
  }
  completionActions.add(identity);
}

function validateBarrierCompletion(
  child: HostedCampaignExecutableSpec,
  completion: Exclude<HostedCampaignExecutableCompletion, HostedFiniteProcessCompletion>,
  input: HostedCampaignInput,
  campaignId: string | undefined,
  completionActions: Set<string>,
): void {
  if (child.startBefore.kind !== "barrier"
    || actionIdentity(child.startBefore.action) !== actionIdentity(completion.action)) {
    throw new Error(`Hosted campaign child ${child.childId} completion does not match its entrypoint and start point`);
  }
  const startBefore = child.startBefore;
  const completionActionIdentity = actionIdentity(completion.action);
  const matchingProduction = child.produces.filter(({ action, ordinal, runId }) =>
    ordinal === startBefore.ordinal && runId === startBefore.runId
    && actionIdentity(action) === completionActionIdentity
  );
  if (matchingProduction.length !== 1) {
    throw new Error(`Hosted campaign child ${child.childId} completion must declare exactly one run-scoped production`);
  }
  if (completionActions.has(completionActionIdentity)) {
    throw new Error(`Hosted campaign action has multiple completion producers: ${completionActionIdentity}`);
  }
  completionActions.add(completionActionIdentity);
  if (completion.action.kind === "run-verified") {
    const completionAction = completion.action;
    if (!input.runs.some(({ ordinal, runId }) =>
      ordinal === completionAction.ordinal && runId === completionAction.runId
    )) {
      throw new Error(`Hosted campaign child ${child.childId} completion does not match a campaign run`);
    }
  }
  if (completion.kind === "collector" && (completion.runId !== completion.action.runId
    || child.environment.DISCORD_E2E_EVIDENCE_OUTPUT !== completion.evidencePath
    || child.environment.DISCORD_E2E_RUN_ID !== completion.runId)) {
    throw new Error(`Hosted campaign collector ${child.childId} completion is not bound to its output and run`);
  }
  if (completion.kind === "provenance-probe") {
    validateProvenanceCompletion(child, completion, input, campaignId);
  }
  if (completion.kind === "service-levels") {
    validateServiceLevelsCompletion(child, completion, campaignId);
  }
  if (completion.kind === "service-level-sources") {
    validateServiceLevelSourcesCompletion(child, completion, campaignId);
  }
  if (completion.kind === "campaign-verifier" && (completion.campaignId !== campaignId
    || JSON.stringify(completion.runIds) !== JSON.stringify(input.runs.map(({ runId }) => runId)))) {
    throw new Error(`Hosted campaign verifier ${child.childId} completion is not bound to the campaign runs`);
  }
}

function validateServiceLevelSourcesCompletion(
  child: HostedCampaignExecutableSpec,
  completion: Extract<HostedCampaignExecutableCompletion, { readonly kind: "service-level-sources" }>,
  campaignId: string | undefined,
): void {
  const environment = child.environment;
  const invalid = completion.campaignId !== campaignId
    || environment.DISCORD_E2E_SLA_CAMPAIGN_ID !== completion.campaignId
    || environment.DISCORD_E2E_SLA_RUN_ID !== completion.runId
    || !matchesStaticOrBinding(child, "DISCORD_E2E_SLA_MEETING_ID", "meetingId", completion.meetingId)
    || !matchesStaticOrBinding(child, "DISCORD_E2E_SLA_RECORDING_ID", "recordingId", completion.recordingId)
    || environment.DISCORD_E2E_SLA_DATABASE_INPUT !== completion.databasePath
    || environment.DISCORD_E2E_SLA_S3_INPUT !== completion.s3Path
    || environment.DISCORD_E2E_SLA_MEETING_PLATFORM_LOG_INPUT !== completion.meetingPlatformLogsPath
    || environment.DISCORD_E2E_SLA_CLOCK_ATTESTATIONS_INPUT !== completion.clockAttestationsPath
    || environment.DISCORD_E2E_SLA_SOURCE_REPORT_OUTPUT !== completion.reportPath;
  if (invalid) {
    throw new Error(`Hosted service-level source producer ${child.childId} is not bound to the campaign`);
  }
}

function validateServiceLevelsCompletion(
  child: HostedCampaignExecutableSpec,
  completion: Extract<HostedCampaignExecutableCompletion, { readonly kind: "service-levels" }>,
  campaignId: string | undefined,
): void {
  const environment = child.environment;
  const invalid = completion.campaignId !== campaignId
    || child.startBefore.kind !== "barrier"
    || child.startBefore.runId !== completion.runId
    || environment.DISCORD_E2E_SLA_CAMPAIGN_ID !== completion.campaignId
    || !matchesStaticOrBinding(child, "DISCORD_E2E_SLA_MEETING_ID", "meetingId", completion.meetingId)
    || environment.DISCORD_E2E_SLA_OUTPUT !== completion.outputPath
    || !matchesStaticOrBinding(child, "DISCORD_E2E_SLA_RECORDING_ID", "recordingId", completion.recordingId)
    || environment.DISCORD_E2E_SLA_REPORT_OUTPUT !== completion.reportPath
    || environment.DISCORD_E2E_SLA_RUN_ID !== completion.runId;
  if (invalid) {
    throw new Error(`Hosted campaign service-level producer ${child.childId} completion is not bound to the campaign`);
  }
}

function matchesStaticOrBinding(
  child: HostedCampaignExecutableSpec,
  name: HostedCampaignBoundEnvironmentName,
  field: "meetingId" | "recordingId",
  declared: string | undefined,
): boolean {
  return declared === undefined
    ? child.environmentBindings?.some((binding) => binding.name === name
      && binding.valueFrom.field === field && binding.valueFrom.actionRef.action.kind === "recording-ready") === true
    : child.environment[name] === declared;
}

function isFiniteCompletion(
  completion: HostedCampaignExecutableCompletion,
): completion is HostedFiniteProcessCompletion {
  return new Set(["actor", "conversation-observer", "greeting-ledger-observer", "historical-reply-observer",
    "historical-reply-preparer", "live-memory-observer", "private-coverage-observer", "remediation-bundle", "playback-link-observer", "recording-ready",
    "replay-attestation-publisher", "supplemental-player"]).has(completion.kind);
}

function validateProvenanceCompletion(
  child: HostedCampaignExecutableSpec,
  completion: Extract<HostedCampaignExecutableCompletion, { readonly kind: "provenance-probe" }>,
  input: HostedCampaignInput,
  campaignId: string | undefined,
): void {
  const invalid = completion.campaignId !== campaignId
    || completion.phase !== (completion.action.kind === "provenance-before" ? "before" : "after")
    || JSON.stringify(completion.runIds) !== JSON.stringify(input.runs.map(({ runId }) => runId))
    || child.environment.DISCORD_E2E_PROVENANCE_CAMPAIGN_ID !== completion.campaignId
    || child.environment.DISCORD_E2E_PROVENANCE_PHASE !== completion.phase
    || child.environment.DISCORD_E2E_PROVENANCE_RUN_IDS_JSON !== JSON.stringify(completion.runIds)
    || child.environment.DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH !== completion.snapshotPath;
  if (invalid) {
    throw new Error(`Hosted campaign provenance producer ${child.childId} completion is not bound to the campaign`);
  }
}
