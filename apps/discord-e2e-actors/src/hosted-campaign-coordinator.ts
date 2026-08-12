export const HOSTED_CAMPAIGN_TARGET = {
  environment: "private-test-guild",
  mutationTarget: "test-only",
  deploymentScope: "private-test-deployment",
  host: "codex-workers-eu-01",
  project: "discord-meeting-assistant",
  craigProject: "craig-meeting-e2e",
  guildId: "1533228590643155034",
  voiceChannelId: "1533228823045214398",
  publicationChannelId: "1533228891827736657",
  sutApplicationId: "1533224474609057793",
  speakerAApplicationId: "1533227577286852649",
  speakerBApplicationId: "1533228054724346087",
  observerApplicationId: "1533867700575670282",
  speakerDApplicationId: "1533873978417086474",
  botikApplicationId: "1534231284467896512",
} as const;

export type HostedCampaignTarget = typeof HOSTED_CAMPAIGN_TARGET;
export type CampaignScenario = "sequential" | "overlap" | "reconnect";

export interface HostedCampaignRun {
  readonly campaignId: string;
  readonly ordinal: number;
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
  | "supplemental-player"
  | "evidence-verifier";

export type HostedCampaignStartPoint = "campaign" | HostedCampaignBarrierAction["kind"];

export type HostedCampaignExecutableArguments =
  | { readonly kind: "environment" }
  | { readonly evidencePath: string; readonly kind: "evidence-verifier"; readonly manifestPath: string; readonly thresholdsPath?: string }
  | { readonly evidencePaths: readonly [string, string, string]; readonly kind: "campaign-verifier"; readonly manifestPath: string; readonly thresholdsPath?: string };

export interface HostedCampaignExecutableSpec {
  readonly arguments: HostedCampaignExecutableArguments;
  readonly childId: string;
  readonly entrypoint: HostedCampaignEntrypoint;
  readonly environment: Readonly<Record<string, string>>;
  readonly startBefore: HostedCampaignStartPoint;
  readonly releaseGate?: {
    readonly action: HostedCampaignBarrierAction;
    readonly path: string;
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
  | { readonly kind: "run-verified"; readonly ordinal: number; readonly runId: string }
  | { readonly kind: "provenance-after" }
  | { readonly kind: "campaign-verified" };

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
            : Action["kind"] extends "answer-intent" | "answer-observer-ready" ? TurnEvidence
              : Action["kind"] extends "run-verified" ? {
                  readonly ordinal: number; readonly runId: string; readonly verified: true;
                }
                : { readonly campaignId: string };

export interface HostedCampaignBoundedSignal {
  readonly deadlineEpochMilliseconds: number;
  readonly signal: AbortSignal;
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
  readonly children: readonly HostedCampaignExecutableSpec[];
  readonly runs: readonly HostedCampaignRun[];
  readonly target: HostedCampaignTarget;
  readonly thresholds: HostedCampaignThresholds;
}

export interface HostedCampaignPassReceipt {
  readonly actionEvidence: readonly unknown[];
  readonly campaignId: string;
  readonly runIds: readonly [string, string, string];
  readonly schemaVersion: 1;
  readonly teardownComplete: true;
}

function campaignActions(input: HostedCampaignInput): readonly HostedCampaignBarrierAction[] {
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
    { kind: "run-verified", ordinal: reconnect!.ordinal, runId: reconnect!.runId },
    { kind: "provenance-after" },
    { kind: "campaign-verified" },
  ];
}

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
  for (const child of input.children) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(child.childId) || childIds.has(child.childId)) {
      throw new Error(`Invalid or duplicate hosted campaign childId: ${child.childId}`);
    }
    childIds.add(child.childId);
    if ((child.entrypoint === "campaign-verifier") !== (child.arguments.kind === "campaign-verifier")
      || (child.entrypoint === "evidence-verifier") !== (child.arguments.kind === "evidence-verifier")) {
      throw new Error(`Hosted campaign child ${child.childId} has arguments for the wrong entrypoint`);
    }
    if (child.startBefore !== "campaign" && !campaignActions(input).some(({ kind }) => kind === child.startBefore)) {
      throw new Error(`Hosted campaign child ${child.childId} has an unknown start point`);
    }
    if ((child.entrypoint === "collector" || child.entrypoint.endsWith("verifier"))
      && child.startBefore === "campaign") {
      throw new Error(`One-shot child ${child.childId} must start only after its inputs exist`);
    }
    if (child.releaseGate !== undefined && child.entrypoint !== "actor") {
      throw new Error(`Only an actor child may declare a hosted release gate`);
    }
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

async function stopEveryChild(
  handles: readonly HostedCampaignChildHandle[], ports: HostedCampaignPorts,
): Promise<void> {
  const results = await Promise.allSettled(handles.map(async (handle) => ports.stopChild(handle)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(({ reason }) => reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to stop every hosted campaign child");
  }
}

function validateEvidence(
  action: HostedCampaignBarrierAction,
  evidence: unknown,
  thresholds: HostedCampaignThresholds,
): void {
  if (typeof evidence !== "object" || evidence === null) {
    throw new Error(`Missing ${action.kind} evidence`);
  }
  const value = evidence as Record<string, unknown>;
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
  if (action.kind === "run-verified" && (value.verified !== true
    || value.ordinal !== action.ordinal || value.runId !== action.runId)) {
    throw new Error(`Run ${action.ordinal} verification evidence is invalid`);
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
  const evidence: unknown[] = [];
  let lease: HostedCampaignLeaseHandle | undefined;
  let failure: unknown;
  try {
    const campaignId = input.runs[0]!.campaignId;
    lease = await ports.acquireCampaignLease(campaignId, bounded);
    if (lease.campaignId !== campaignId) {
      throw new Error("Acquired campaign lease does not match the campaign");
    }
    const startChildren = async (startBefore: HostedCampaignStartPoint): Promise<void> => {
      for (const executable of input.children.filter((child) => child.startBefore === startBefore)) {
        assertActive(bounded);
        const handle = await ports.startChild(executable, bounded);
        handles.push(handle);
        if (handle.childId !== executable.childId) {
          throw new Error("Started child handle does not match its executable spec");
        }
      }
    };
    await startChildren("campaign");
    for (const action of campaignActions(input)) {
      await startChildren(action.kind);
      assertActive(bounded);
      const actionEvidence = await ports.awaitBarrier(action, bounded);
      validateEvidence(action, actionEvidence, input.thresholds);
      evidence.push(Object.freeze({ action, evidence: actionEvidence }));
      for (const executable of input.children.filter((child) =>
        child.releaseGate !== undefined
        && JSON.stringify(child.releaseGate.action) === JSON.stringify(action)
      )) {
        await ports.publishReleaseGate(executable, bounded);
      }
    }
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
  if (failure !== undefined) {
    throw failure;
  }
  return Object.freeze({
    actionEvidence: Object.freeze(evidence),
    campaignId: input.runs[0]!.campaignId,
    runIds: [input.runs[0]!.runId, input.runs[1]!.runId, input.runs[2]!.runId] as const,
    schemaVersion: 1,
    teardownComplete: true,
  });
}
