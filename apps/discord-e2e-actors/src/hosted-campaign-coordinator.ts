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
  readonly ordinal: number;
  readonly scenario: CampaignScenario;
  readonly runId: string;
  readonly campaignId: string;
  readonly retainedCaptureCount: number;
}

export interface HostedCampaignInput {
  readonly target: HostedCampaignTarget;
  readonly runs: readonly HostedCampaignRun[];
}

export type HostedCampaignAction =
  | "preflight"
  | "provenance-before"
  | "observer-subscribed"
  | "capture-retained"
  | "reconnect-left"
  | "reconnect-ready"
  | "answer-intent"
  | "answer-observer-ready"
  | "answer-first-packet"
  | "run-verified"
  | "provenance-after"
  | "campaign-verified"
  | "child-closed"
  | "teardown-complete";

export interface HostedCampaignActionResult {
  readonly ownedChildIds?: readonly string[];
  readonly answerLatencyMilliseconds?: number;
}

export interface HostedCampaignPorts {
  perform(action: HostedCampaignAction): Promise<HostedCampaignActionResult | void>;
  closeOwnedChild(childId: string): Promise<void>;
  issuePassReceipt(receipt: HostedCampaignPassReceipt): Promise<void>;
}

export interface HostedCampaignPassReceipt {
  readonly campaignId: string;
  readonly runIds: readonly [string, string, string];
  readonly actionOrder: readonly HostedCampaignAction[];
  readonly teardownComplete: true;
}

const ACTION_ORDER: readonly HostedCampaignAction[] = [
  "preflight",
  "provenance-before",
  "observer-subscribed",
  ...Array.from({ length: 6 }, () => "capture-retained" as const),
  "reconnect-left",
  "reconnect-ready",
  "answer-intent",
  "answer-observer-ready",
  "answer-first-packet",
  "run-verified",
  "provenance-after",
  "campaign-verified",
  "child-closed",
  "teardown-complete",
];

interface CampaignState {
  readonly nextActionIndex: number;
  readonly ownedChildIds: readonly string[];
}

function advanceCampaignState(
  state: CampaignState,
  action: HostedCampaignAction,
  result: HostedCampaignActionResult | void,
): CampaignState {
  const expected = ACTION_ORDER[state.nextActionIndex];
  if (action !== expected) {
    throw new Error(`Expected campaign action ${String(expected)}, received ${action}`);
  }
  if (action === "answer-first-packet") {
    const latency = result?.answerLatencyMilliseconds;
    if (latency === undefined || latency < 0 || latency > 4_000) {
      throw new Error(`Answer first-packet SLA failed: ${String(latency)}ms`);
    }
  }
  return { ...state, nextActionIndex: state.nextActionIndex + 1 };
}

function registerOwnedChildren(
  state: CampaignState,
  action: HostedCampaignAction,
  result: HostedCampaignActionResult | void,
): CampaignState {
  const newChildren = result?.ownedChildIds ?? [];
  if ((action === "child-closed" || action === "teardown-complete") && newChildren.length > 0) {
    throw new Error(`Campaign action ${action} cannot create an owned child`);
  }
  const seen = new Set(state.ownedChildIds);
  for (const childId of newChildren) {
    if (childId.length === 0 || seen.has(childId)) {
      throw new Error(`Invalid or duplicate owned child id: ${childId}`);
    }
    seen.add(childId);
  }
  return {
    ...state,
    ownedChildIds: [...state.ownedChildIds, ...newChildren],
  };
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
    const expectedCaptures = run.scenario === "reconnect" ? 6 : 0;
    if (run.retainedCaptureCount !== expectedCaptures) {
      throw new Error("Only the reconnect run may own exactly six retained captures");
    }
  });
}

async function closeEveryOwnedChild(
  childIds: readonly string[],
  ports: HostedCampaignPorts,
): Promise<void> {
  const results = await Promise.allSettled(childIds.map((childId) => ports.closeOwnedChild(childId)));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to close every owned campaign child");
  }
}

export async function runHostedCampaign(
  input: HostedCampaignInput,
  ports: HostedCampaignPorts,
): Promise<HostedCampaignPassReceipt> {
  validateHostedCampaign(input);
  let state: CampaignState = { nextActionIndex: 0, ownedChildIds: [] };
  let childrenClosed = false;
  try {
    for (const action of ACTION_ORDER) {
      if (action === "child-closed") {
        await closeEveryOwnedChild(state.ownedChildIds, ports);
      }
      const result = await ports.perform(action);
      state = registerOwnedChildren(state, action, result);
      state = advanceCampaignState(state, action, result);
      if (action === "child-closed") {
        childrenClosed = true;
      }
    }
    const receipt: HostedCampaignPassReceipt = {
      campaignId: input.runs[0]!.campaignId,
      runIds: [input.runs[0]!.runId, input.runs[1]!.runId, input.runs[2]!.runId],
      actionOrder: ACTION_ORDER,
      teardownComplete: true,
    };
    await ports.issuePassReceipt(receipt);
    return receipt;
  } catch (error) {
    if (!childrenClosed) {
      try {
        await closeEveryOwnedChild(state.ownedChildIds, ports);
      } catch (cleanupError) {
        const campaignFailure = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Hosted campaign failed (${campaignFailure}) and cleanup was incomplete`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}
