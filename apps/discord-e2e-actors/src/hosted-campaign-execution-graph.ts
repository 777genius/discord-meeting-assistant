import type {
  HostedCampaignActionReference,
  HostedCampaignBarrierAction,
  HostedCampaignInput,
  HostedCampaignRun,
} from "./hosted-campaign-coordinator.js";

export function campaignActions(input: HostedCampaignInput): readonly HostedCampaignActionReference[] {
  const [sequential, overlap, reconnect] = input.runs;
  const base = [
    scoped(sequential!, { kind: "provenance-before" }),
    scoped(sequential!, { kind: "observer-subscribed" }),
    scoped(sequential!, { kind: "run-verified", ordinal: 1, runId: sequential!.runId }),
    scoped(overlap!, { kind: "run-verified", ordinal: 2, runId: overlap!.runId }),
    ...Array.from({ length: 4 }, (_, index) => scoped(reconnect!, {
      kind: "capture-retained", ordinal: index + 1,
    })),
    scoped(reconnect!, { kind: "reconnect-left" }),
    scoped(reconnect!, { kind: "reconnect-ready" }),
    scoped(reconnect!, { kind: "answer-intent" }),
    scoped(reconnect!, { kind: "answer-observer-ready" }),
    scoped(reconnect!, { kind: "answer-first-packet" }),
    scoped(reconnect!, { kind: "capture-retained", ordinal: 5 }),
    scoped(reconnect!, { kind: "capture-retained", ordinal: 6 }),
    scoped(reconnect!, { kind: "service-levels-ready" }),
    scoped(reconnect!, { kind: "run-verified", ordinal: 3, runId: reconnect!.runId }),
    scoped(reconnect!, { kind: "provenance-after" }),
    scoped(reconnect!, { kind: "campaign-verified" }),
  ];
  const completions = new Map<string, HostedCampaignActionReference[]>();
  for (const child of input.children) {
    if (child.completion === undefined || !("action" in child.completion)
      || !isFiniteCompletionAction(child.completion.action)) {continue;}
    const trigger = child.releaseGate ?? (child.startBefore.kind === "barrier" ? child.startBefore : undefined);
    if (trigger === undefined) {
      throw new Error(`Hosted finite child ${child.childId} requires a release gate or barrier start`);
    }
    const key = actionReferenceIdentity(trigger);
    const reference = { action: child.completion.action, ordinal: child.completion.action.ordinal,
      runId: child.completion.action.runId };
    completions.set(key, [...(completions.get(key) ?? []), reference]);
  }
  return base.flatMap((reference) => [reference, ...(completions.get(actionReferenceIdentity(reference)) ?? [])]);
}

function isFiniteCompletionAction(action: HostedCampaignBarrierAction): action is Extract<
  HostedCampaignBarrierAction,
  { readonly kind: "actor-completed" | "conversation-observer-completed" | "playback-link-seen" | "recording-ready" | "supplemental-completed" }
> {
  return new Set(["actor-completed", "conversation-observer-completed", "playback-link-seen",
    "recording-ready", "supplemental-completed"]).has(action.kind);
}

function scoped(run: HostedCampaignRun, action: HostedCampaignBarrierAction): HostedCampaignActionReference {
  return { action, ordinal: run.ordinal, runId: run.runId };
}

export function actionIdentity(action: HostedCampaignBarrierAction): string {
  if (action.kind === "capture-retained") {return `${action.kind}:${action.ordinal}`;}
  if (action.kind === "run-verified") {return `${action.kind}:${action.ordinal}:${action.runId}`;}
  if (isFiniteCompletionAction(action)) {return `${action.kind}:${action.ordinal}:${action.runId}`;}
  return action.kind;
}

export function actionReferenceIdentity(reference: HostedCampaignActionReference): string {
  return `${reference.ordinal}:${reference.runId}:${actionIdentity(reference.action)}`;
}

export function validateExecutionGraph(input: HostedCampaignInput): void {
  const expected = campaignActions(input);
  const expectedIds = new Set(expected.map(actionReferenceIdentity));
  const order = new Map(expected.map((reference, index) => [actionReferenceIdentity(reference), index]));
  const producers = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const child of input.children) {
    for (const produced of child.produces) {
      const identity = assertKnown(produced, expectedIds, child.childId);
      const existing = producers.get(identity);
      if (existing !== undefined) {throw new Error(`Hosted campaign action ${identity} has multiple producers: ${existing}, ${child.childId}`);}
      const pathOwner = paths.get(produced.outputPath);
      if (pathOwner !== undefined) {throw new Error(`Hosted campaign output path collision between ${pathOwner} and ${identity}`);}
      producers.set(identity, child.childId); paths.set(produced.outputPath, identity);
    }
    for (const required of child.requires) {
      const requiredId = assertKnown(required, expectedIds, child.childId);
      if (child.startBefore.kind === "campaign") {throw new Error(`Hosted campaign child ${child.childId} cannot require an action before campaign start`);}
      if (order.get(requiredId)! >= order.get(actionReferenceIdentity(child.startBefore))!) {
        throw new Error(`Hosted campaign child ${child.childId} requirement must precede its start action`);
      }
    }
    validateEnvironmentBindings(child, expectedIds, order);
  }
  for (const reference of expected) {
    const identity = actionReferenceIdentity(reference);
    if (!producers.has(identity)) {throw new Error(`Hosted campaign action ${identity} has no producer`);}
  }
  assertAcyclic(input, producers);
}

const BOUND_FIELDS = new Map<string, ReadonlySet<string>>([
  ["meetingId", new Set([
    "DISCORD_E2E_CONVERSATION_VOICE_MEETING_ID", "DISCORD_E2E_SLA_MEETING_ID",
  ])],
  ["recordingId", new Set([
    "DISCORD_E2E_CONVERSATION_VOICE_RECORDING_ID", "DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID",
    "DISCORD_E2E_RECORDING_ID", "DISCORD_E2E_SLA_RECORDING_ID",
  ])],
]);

function validateEnvironmentBindings(
  child: HostedCampaignInput["children"][number],
  expected: ReadonlySet<string>,
  order: ReadonlyMap<string, number>,
): void {
  const names = new Set<string>();
  for (const binding of child.environmentBindings ?? []) {
    const sourceId = assertKnown(binding.valueFrom.actionRef, expected, child.childId);
    if (binding.valueFrom.actionRef.action.kind !== "recording-ready") {
      throw new Error(`Hosted campaign child ${child.childId} environment binding source must be recording-ready`);
    }
    if (!BOUND_FIELDS.get(binding.valueFrom.field)?.has(binding.name)) {
      throw new Error(`Hosted campaign child ${child.childId} environment binding field/name pair is not allowed`);
    }
    if (names.has(binding.name) || Object.hasOwn(child.environment, binding.name)) {
      throw new Error(`Hosted campaign child ${child.childId} environment binding collides at ${binding.name}`);
    }
    names.add(binding.name);
    if (child.startBefore.kind === "campaign"
      || order.get(sourceId)! >= order.get(actionReferenceIdentity(child.startBefore))!) {
      throw new Error(`Hosted campaign child ${child.childId} environment binding source must precede its start action`);
    }
    if (!child.requires.some((required) => actionReferenceIdentity(required) === sourceId)) {
      throw new Error(`Hosted campaign child ${child.childId} environment binding source must be an explicit requirement`);
    }
  }
}

function assertKnown(reference: HostedCampaignActionReference, expected: ReadonlySet<string>, childId: string): string {
  const identity = actionReferenceIdentity(reference);
  if (!expected.has(identity)) {throw new Error(`Hosted campaign child ${childId} references unknown action ${identity}`);}
  return identity;
}

function assertAcyclic(input: HostedCampaignInput, producers: ReadonlyMap<string, string>): void {
  const children = new Map(input.children.map((child) => [child.childId, child]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (childId: string): void => {
    if (visiting.has(childId)) {throw new Error(`Hosted campaign execution graph contains a cycle at ${childId}`);}
    if (visited.has(childId)) {return;}
    visiting.add(childId);
    for (const required of children.get(childId)!.requires) {visit(producers.get(actionReferenceIdentity(required))!);}
    visiting.delete(childId); visited.add(childId);
  };
  for (const child of input.children) {visit(child.childId);}
}
