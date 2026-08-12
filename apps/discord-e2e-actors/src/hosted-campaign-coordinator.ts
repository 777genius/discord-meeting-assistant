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

export type HostedCampaignEntrypoint =
  | "actor"
  | "campaign-verifier"
  | "collector"
  | "conversation-observer"
  | "live-observer"
  | "supplemental-player"
  | "evidence-verifier";

export interface HostedCampaignExecutableSpec {
  readonly arguments: readonly string[];
  readonly childId: string;
  readonly entrypoint: HostedCampaignEntrypoint;
  readonly environment: Readonly<Record<string, string>>;
}

declare const childHandleBrand: unique symbol;
export interface HostedCampaignChildHandle {
  readonly childId: string;
  readonly [childHandleBrand]: true;
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
  | { readonly kind: "run-verified" }
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
              : Action["kind"] extends "run-verified" ? { readonly runIds: readonly string[] }
                : { readonly campaignId: string };

export interface HostedCampaignBoundedSignal {
  readonly deadlineEpochMilliseconds: number;
  readonly signal: AbortSignal;
}

export interface HostedCampaignPorts {
  awaitBarrier<Action extends HostedCampaignBarrierAction>(
    action: Action,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<HostedCampaignActionEvidence<Action>>;
  startChild(
    executable: HostedCampaignExecutableSpec,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<HostedCampaignChildHandle>;
  stopChild(handle: HostedCampaignChildHandle): Promise<void>;
}

export interface HostedCampaignInput {
  readonly children: readonly HostedCampaignExecutableSpec[];
  readonly runs: readonly HostedCampaignRun[];
  readonly target: HostedCampaignTarget;
}

export interface HostedCampaignPassReceipt {
  readonly actionEvidence: readonly unknown[];
  readonly campaignId: string;
  readonly runIds: readonly [string, string, string];
  readonly schemaVersion: 1;
  readonly teardownComplete: true;
}

const ACTIONS: readonly HostedCampaignBarrierAction[] = [
  { kind: "provenance-before" },
  { kind: "observer-subscribed" },
  ...Array.from({ length: 6 }, (_, index) => ({ kind: "capture-retained" as const, ordinal: index + 1 })),
  { kind: "reconnect-left" }, { kind: "reconnect-ready" }, { kind: "answer-intent" },
  { kind: "answer-observer-ready" }, { kind: "answer-first-packet" }, { kind: "run-verified" },
  { kind: "provenance-after" }, { kind: "campaign-verified" },
];

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
  const childIds = new Set<string>();
  for (const child of input.children) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(child.childId) || childIds.has(child.childId)) {
      throw new Error(`Invalid or duplicate hosted campaign childId: ${child.childId}`);
    }
    childIds.add(child.childId);
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

function validateEvidence(action: HostedCampaignBarrierAction, evidence: unknown): void {
  if (typeof evidence !== "object" || evidence === null) {
    throw new Error(`Missing ${action.kind} evidence`);
  }
  const value = evidence as Record<string, unknown>;
  if (action.kind === "capture-retained" && (value.retained !== true || value.ordinal !== action.ordinal)) {
    throw new Error(`Capture ${action.ordinal} retained evidence is invalid`);
  }
  if (action.kind === "answer-first-packet") {
    const latency = value.answerLatencyMilliseconds;
    if (typeof latency !== "number" || latency < 0 || latency > 4_000) {
      throw new Error(`Answer first-packet SLA failed: ${String(latency)}ms`);
    }
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
  let stopped = false;
  try {
    for (const executable of input.children) {
      assertActive(bounded);
      const handle = await ports.startChild(executable, bounded);
      if (handle.childId !== executable.childId) {
        throw new Error("Started child handle does not match its executable spec");
      }
      handles.push(handle);
    }
    for (const action of ACTIONS) {
      assertActive(bounded);
      const actionEvidence = await ports.awaitBarrier(action, bounded);
      validateEvidence(action, actionEvidence);
      evidence.push(Object.freeze({ action, evidence: actionEvidence }));
    }
    await stopEveryChild(handles, ports);
    stopped = true;
    return Object.freeze({
      actionEvidence: Object.freeze(evidence),
      campaignId: input.runs[0]!.campaignId,
      runIds: [input.runs[0]!.runId, input.runs[1]!.runId, input.runs[2]!.runId] as const,
      schemaVersion: 1,
      teardownComplete: true,
    });
  } catch (error) {
    if (!stopped) {
      try { await stopEveryChild(handles, ports); }
      catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Hosted campaign failed and cleanup was incomplete",
        );
      }
    }
    throw error;
  }
}
