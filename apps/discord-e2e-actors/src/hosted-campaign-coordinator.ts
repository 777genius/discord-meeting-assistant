import { actionIdentity, actionReferenceIdentity, campaignActions, validateExecutionGraph } from "./hosted-campaign-execution-graph.js";
import { stopEveryChild, validateActionEvidence } from "./hosted-campaign-actions.js";
import {
  type HostedFiniteProcessCompletion,
  validateHostedFiniteProcessContract,
} from "./hosted-finite-process-contract.js";

export const HOSTED_CAMPAIGN_TARGET = {
  environment: "private-test-guild", mutationTarget: "test-only", deploymentScope: "private-test-deployment",
  host: "codex-workers-eu-01", project: "discord-meeting-assistant", craigProject: "craig-meeting-e2e",
  guildId: "1533228590643155034", voiceChannelId: "1533228823045214398",
  publicationChannelId: "1533228891827736657", sutApplicationId: "1533224474609057793",
  speakerAApplicationId: "1533227577286852649", speakerBApplicationId: "1533228054724346087",
  observerApplicationId: "1533867700575670282", speakerDApplicationId: "1533873978417086474",
  botikApplicationId: "1534231284467896512",
} as const;
export type HostedCampaignTarget = typeof HOSTED_CAMPAIGN_TARGET;
export type CampaignScenario = "sequential" | "overlap" | "reconnect";
export interface HostedCampaignRun {
  readonly campaignId: string; readonly ordinal: number;
  readonly retainedCaptureCount: number;
  readonly runId: string;
  readonly scenario: CampaignScenario;
}
export interface HostedCampaignThresholds {
  readonly answerFirstPacketMilliseconds: number;
}
export type HostedCampaignEntrypoint =
  | "actor"
  | "campaign-verifier"
  | "collector"
  | "conversation-observer"
  | "live-observer"
  | "playback-link-observer"
  | "provenance-probe"
  | "recording-ready"
  | "service-levels"
  | "supplemental-player"
  | "evidence-verifier";
export interface HostedCampaignActionReference {
  readonly action: HostedCampaignBarrierAction;
  readonly ordinal: number;
  readonly runId: string;
}
export type HostedCampaignStartPoint =
  | { readonly kind: "campaign" }
  | HostedCampaignActionReference & { readonly kind: "barrier" };
export interface HostedCampaignProducedAction extends HostedCampaignActionReference {
  readonly outputPath: string;
}
export type HostedCampaignCompletionAction =
  | { readonly kind: "actor-completed"; readonly ordinal: number; readonly runId: string }
  | { readonly kind: "conversation-observer-completed"; readonly ordinal: number; readonly runId: string }
  | { readonly kind: "playback-link-seen"; readonly ordinal: number; readonly runId: string }
  | { readonly kind: "recording-ready"; readonly ordinal: number; readonly runId: string }
  | { readonly kind: "supplemental-completed"; readonly ordinal: number; readonly runId: string };
export type HostedCampaignExecutableArguments =
  | { readonly kind: "environment" }
  | { readonly evidencePath: string; readonly kind: "evidence-verifier"; readonly manifestPath: string; readonly thresholdsPath?: string }
  | { readonly evidencePaths: readonly [string, string, string]; readonly kind: "campaign-verifier"; readonly manifestPath: string; readonly thresholdsPath?: string };
export type HostedCampaignExecutableCompletion =
  | HostedFiniteProcessCompletion
  | {
      readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "service-levels-ready" }>;
      readonly campaignId: string;
      readonly kind: "service-levels";
      readonly meetingId: string;
      readonly outputPath: string;
      readonly recordingId: string;
      readonly reportPath: string;
      readonly runId: string;
    }
  | {
      readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "provenance-before" | "provenance-after" }>;
      readonly campaignId: string;
      readonly kind: "provenance-probe";
      readonly phase: "after" | "before";
      readonly runIds: readonly [string, string, string];
      readonly snapshotPath: string;
    }
  | {
      readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "run-verified" }>;
      readonly evidencePath: string;
      readonly kind: "collector";
      readonly runId: string;
    }
  | {
      readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "run-verified" }>;
      readonly kind: "evidence-verifier";
    }
  | {
      readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "campaign-verified" }>;
      readonly campaignId: string;
      readonly kind: "campaign-verifier";
      readonly runIds: readonly [string, string, string];
    };
export interface HostedCampaignExecutableSpec {
  readonly arguments: HostedCampaignExecutableArguments;
  readonly childId: string;
  readonly completion?: HostedCampaignExecutableCompletion;
  readonly entrypoint: HostedCampaignEntrypoint;
  readonly environment: Readonly<Record<string, string>>;
  readonly produces: readonly HostedCampaignProducedAction[];
  readonly requires: readonly HostedCampaignActionReference[];
  readonly startBefore: HostedCampaignStartPoint;
  readonly releaseGate?: {
    readonly action: HostedCampaignBarrierAction;
    readonly ordinal: number;
    readonly path: string;
    readonly runId: string;
  };
}
declare const childHandleBrand: unique symbol;
export interface HostedCampaignChildHandle {
  readonly childId: string;
  readonly [childHandleBrand]: true;
}
declare const campaignLeaseHandleBrand: unique symbol;
export interface HostedCampaignLeaseHandle {
  readonly campaignId: string;
  readonly [campaignLeaseHandleBrand]: true;
}
export type HostedCampaignBarrierAction =
  | { readonly kind: "provenance-before" }
  | { readonly kind: "observer-subscribed" }
  | { readonly kind: "capture-retained"; readonly ordinal: number }
  | { readonly kind: "reconnect-left" }
  | { readonly kind: "reconnect-ready" }
  | { readonly kind: "answer-intent" }
  | { readonly kind: "answer-observer-ready" }
  | { readonly kind: "answer-first-packet" }
  | { readonly kind: "service-levels-ready" }
  | { readonly kind: "run-verified"; readonly ordinal: number; readonly runId: string }
  | { readonly kind: "provenance-after" }
  | { readonly kind: "campaign-verified" }
  | HostedCampaignCompletionAction;
interface DigestEvidence { readonly digestSha256: string }
interface TurnEvidence { readonly observedAtEpochMilliseconds: number; readonly turnId: string }
export type HostedCampaignActionEvidence<Action extends HostedCampaignBarrierAction> =
  Action["kind"] extends "provenance-before" | "provenance-after" ? DigestEvidence
    : Action["kind"] extends "observer-subscribed" ? { readonly authenticatedObserverBotId: string }
      : Action["kind"] extends "capture-retained" ? {
          readonly ordinal: number; readonly outputPath: string; readonly retained: true;
        }
        : Action["kind"] extends "reconnect-left" | "reconnect-ready" ? {
            readonly participantId: string; readonly observedAtEpochMilliseconds: number;
          }
          : Action["kind"] extends "answer-first-packet" ? TurnEvidence & {
              readonly answerLatencyMilliseconds: number;
            }
            : Action["kind"] extends "service-levels-ready" ? {
                readonly measurementCount: 3;
                readonly outputPath: string;
                readonly recordingId: string;
                readonly runId: string;
              }
            : Action["kind"] extends "answer-intent" | "answer-observer-ready" ? TurnEvidence
              : Action["kind"] extends "run-verified" ? {
                  readonly ordinal: number; readonly runId: string; readonly verified: true;
                }
                : Action extends HostedCampaignCompletionAction ? {
                    readonly completed: true; readonly ordinal: number; readonly runId: string;
                  }
                  : { readonly campaignId: string };
export interface HostedCampaignBoundedSignal {
  readonly deadlineEpochMilliseconds: number; readonly signal: AbortSignal;
}
export interface HostedCampaignPorts {
  acquireCampaignLease(
    campaignId: string,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<HostedCampaignLeaseHandle>;
  awaitBarrier<Action extends HostedCampaignBarrierAction>(
    action: Action,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<HostedCampaignActionEvidence<Action>>;
  awaitChildCompletion(
    handle: HostedCampaignChildHandle,
    executable: HostedCampaignExecutableSpec,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<void>;
  startChild(
    executable: HostedCampaignExecutableSpec,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<HostedCampaignChildHandle>;
  publishReleaseGate(
    executable: HostedCampaignExecutableSpec,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<void>;
  releaseCampaignLease(handle: HostedCampaignLeaseHandle): Promise<void>;
  stopChild(handle: HostedCampaignChildHandle): Promise<void>;
}
export interface HostedCampaignInput {
  readonly children: readonly HostedCampaignExecutableSpec[]; readonly runs: readonly HostedCampaignRun[];
  readonly target: HostedCampaignTarget;
  readonly thresholds: HostedCampaignThresholds;
}
export interface HostedCampaignPassReceipt {
  readonly actionEvidence: readonly unknown[]; readonly campaignId: string;
  readonly runIds: readonly [string, string, string];
  readonly schemaVersion: 1; readonly teardownComplete: true;
}
function startPointIdentity(startPoint: HostedCampaignStartPoint): string {
  return startPoint.kind === "campaign" ? "campaign" : `barrier:${actionReferenceIdentity(startPoint)}`;
}
// The coordinator is kept as one readable vertical slice; graph validation is isolated above.
/* oxlint-disable max-lines */
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
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(child.childId) || childIds.has(child.childId)) {
    throw new Error(`Invalid or duplicate hosted campaign childId: ${child.childId}`);
  }
  childIds.add(child.childId);
  if ((child.entrypoint === "campaign-verifier") !== (child.arguments.kind === "campaign-verifier")
    || (child.entrypoint === "evidence-verifier") !== (child.arguments.kind === "evidence-verifier")) {
    throw new Error(`Hosted campaign child ${child.childId} has arguments for the wrong entrypoint`);
  }
  if (child.startBefore.kind === "barrier") {
    const startActionIdentity = actionReferenceIdentity(child.startBefore);
    if (!campaignActions(input).some((reference) => actionReferenceIdentity(reference) === startActionIdentity)) {
      throw new Error(`Hosted campaign child ${child.childId} has an unknown start point`);
    }
  }
  const oneShot = child.completion !== undefined;
  if (oneShot && child.startBefore.kind === "campaign"
    && !(child.completion !== undefined && isFiniteCompletion(child.completion) && child.releaseGate !== undefined)) {
    throw new Error(`One-shot child ${child.childId} must start only after its inputs exist`);
  }
  if (child.completion !== undefined) {
    validateCompletion(child, child.completion, input, campaignId, completionActions);
  }
  if (child.releaseGate !== undefined && child.entrypoint !== "actor") {
    throw new Error(`Only an actor child may declare a hosted release gate`);
  }
  if (child.releaseGate !== undefined
    && child.environment.DISCORD_E2E_HOSTED_RELEASE_GATE_PATH !== child.releaseGate.path) {
    throw new Error(`Hosted campaign actor ${child.childId} release gate path mismatch`);
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
    return;
  }
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
  if (completion.kind === "campaign-verifier" && (completion.campaignId !== campaignId
    || JSON.stringify(completion.runIds) !== JSON.stringify(input.runs.map(({ runId }) => runId)))) {
    throw new Error(`Hosted campaign verifier ${child.childId} completion is not bound to the campaign runs`);
  }
}
function validateServiceLevelsCompletion(
  child: HostedCampaignExecutableSpec,
  completion: Extract<HostedCampaignExecutableCompletion, { readonly kind: "service-levels" }>,
  campaignId: string | undefined,
): void {
  const environment = child.environment;
  const invalid = completion.action.kind !== "service-levels-ready"
    || completion.campaignId !== campaignId
    || child.startBefore.kind !== "barrier"
    || child.startBefore.runId !== completion.runId
    || environment.DISCORD_E2E_SLA_CAMPAIGN_ID !== completion.campaignId
    || environment.DISCORD_E2E_SLA_MEETING_ID !== completion.meetingId
    || environment.DISCORD_E2E_SLA_OUTPUT !== completion.outputPath
    || environment.DISCORD_E2E_SLA_RECORDING_ID !== completion.recordingId
    || environment.DISCORD_E2E_SLA_REPORT_OUTPUT !== completion.reportPath
    || environment.DISCORD_E2E_SLA_RUN_ID !== completion.runId;
  if (invalid) {
    throw new Error(`Hosted campaign service-level producer ${child.childId} completion is not bound to the campaign`);
  }
}

function isFiniteCompletion(
  completion: HostedCampaignExecutableCompletion,
): completion is HostedFiniteProcessCompletion {
  return new Set(["actor", "conversation-observer", "playback-link-observer", "recording-ready",
    "supplemental-player"]).has(completion.kind);
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
function assertActive(bounded: HostedCampaignBoundedSignal): void {
  if (bounded.signal.aborted) {
    throw bounded.signal.reason ?? new Error("Hosted campaign cancelled");
  }
  if (!Number.isSafeInteger(bounded.deadlineEpochMilliseconds) || bounded.deadlineEpochMilliseconds <= Date.now()) {
    throw new Error("Hosted campaign deadline has expired");
  }
}
export async function runHostedCampaign(
  input: HostedCampaignInput,
  ports: HostedCampaignPorts,
  bounded: HostedCampaignBoundedSignal,
): Promise<HostedCampaignPassReceipt> {
  validateHostedCampaign(input);
  assertActive(bounded);
  const handles: HostedCampaignChildHandle[] = [];
  const completionTasks: Promise<void>[] = [];
  const completionFailures: Promise<never>[] = [];
  const evidence: unknown[] = [];
  let lease: HostedCampaignLeaseHandle | undefined;
  let failure: unknown;
  try {
    const campaignId = input.runs[0]!.campaignId;
    lease = await ports.acquireCampaignLease(campaignId, bounded);
    if (lease.campaignId !== campaignId) {
      throw new Error("Acquired campaign lease does not match the campaign");
    }
    const startedChildIds = new Set<string>();
    const startChildren = async (startBefore: HostedCampaignStartPoint): Promise<void> => {
      const identity = startPointIdentity(startBefore);
      for (const executable of input.children.filter((child) => startPointIdentity(child.startBefore) === identity)) {
        if (startedChildIds.has(executable.childId)) {
          throw new Error(`Hosted campaign child would start more than once: ${executable.childId}`);
        }
        assertActive(bounded);
        const handle = await ports.startChild(executable, bounded);
        handles.push(handle);
        if (handle.childId !== executable.childId) {
          throw new Error("Started child handle does not match its executable spec");
        }
        startedChildIds.add(executable.childId);
        if (executable.completion !== undefined) {
          const completion = ports.awaitChildCompletion(handle, executable, bounded);
          completionTasks.push(completion);
          completionFailures.push(completion.then(
            async () => new Promise<never>(() => {}),
            async (error: unknown) => {throw error;},
          ));
        }
      }
    };
    await startChildren({ kind: "campaign" });
    for (const reference of campaignActions(input)) {
      const { action } = reference;
      await startChildren({ ...reference, kind: "barrier" });
      assertActive(bounded);
      const actionEvidence = await Promise.race([
        ports.awaitBarrier(action, bounded),
        ...completionFailures,
      ]);
      validateActionEvidence(action, actionEvidence, input.thresholds);
      evidence.push(Object.freeze({ action, evidence: actionEvidence }));
      for (const executable of input.children.filter((child) =>
        child.releaseGate !== undefined
        && actionReferenceIdentity(child.releaseGate) === actionReferenceIdentity(reference)
      )) {
        await ports.publishReleaseGate(executable, bounded);
      }
    }
    await Promise.all(completionTasks);
  } catch (error) {
    failure = error;
  }
  const cleanupFailures: unknown[] = [];
  try {
    await stopEveryChild(handles, ports);
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (lease !== undefined) {
    try {
      await ports.releaseCampaignLease(lease);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      failure === undefined
        ? "Hosted campaign cleanup was incomplete"
        : "Hosted campaign failed and cleanup was incomplete",
      failure === undefined ? undefined : { cause: failure },
    );
  }
  if (failure !== undefined) {throw failure instanceof Error
    ? failure : new Error("Hosted campaign failed", { cause: failure });}
  return Object.freeze({
    actionEvidence: Object.freeze(evidence),
    campaignId: input.runs[0]!.campaignId,
    runIds: [input.runs[0]!.runId, input.runs[1]!.runId, input.runs[2]!.runId] as const,
    schemaVersion: 1,
    teardownComplete: true,
  });
}
