import { actionReferenceIdentity, campaignActions } from "./hosted-campaign-execution-graph.js";
import { stopEveryChild, validateActionEvidence } from "./hosted-campaign-actions.js";
import { validateHostedCampaign } from "./hosted-campaign-validation.js";
import type {
  HostedCampaignActionReference,
  HostedCampaignActionEvidence,
  HostedCampaignBarrierAction,
  HostedCampaignBoundedSignal,
  HostedCampaignChildHandle,
  HostedCampaignExecutableSpec,
  HostedCampaignInput,
  HostedCampaignLeaseHandle,
  HostedCampaignRuntimeAuthorization,
  HostedCampaignPassReceipt,
  HostedCampaignPorts,
  HostedCampaignStartPoint,
} from "./hosted-campaign-coordinator.js";

const BARRIER_RACE_COMPLETED = "Hosted campaign barrier race completed";
const BARRIER_TEARDOWN_GRACE_MILLISECONDS = 250;

async function awaitBarrierTeardown(barrier: Promise<unknown>): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      barrier.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          resolve(false);
        }, BARRIER_TEARDOWN_GRACE_MILLISECONDS);
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

function startPointIdentity(startPoint: HostedCampaignStartPoint): string {
  return startPoint.kind === "campaign" ? "campaign" : `barrier:${actionReferenceIdentity(startPoint)}`;
}

function supplementalGatePhase(
  child: HostedCampaignExecutableSpec,
  reference: HostedCampaignActionReference,
): "connection" | "playback" | undefined {
  return (["connection", "playback"] as const).find((phase) => {
    const gate = child.supplementalGates?.[phase];
    return gate !== undefined && actionReferenceIdentity(gate.trigger) === actionReferenceIdentity(reference);
  });
}

function actorGatePhase(
  child: HostedCampaignExecutableSpec,
  reference: HostedCampaignActionReference,
): "connection" | "speaker-b" | "playback" | "end" | undefined {
  if (child.releaseGate !== undefined
    && actionReferenceIdentity(child.releaseGate) === actionReferenceIdentity(reference)) { return "connection"; }
  return (["speakerB", "playback", "end"] as const).find((phase) => {
    const gate = child.actorGates?.[phase];
    return gate !== undefined && actionReferenceIdentity(gate.trigger) === actionReferenceIdentity(reference);
  })?.replace("speakerB", "speaker-b") as "speaker-b" | "playback" | "end" | undefined;
}

function assertActive(bounded: HostedCampaignBoundedSignal): void {
  if (bounded.signal.aborted) {
    throw bounded.signal.reason ?? new Error("Hosted campaign cancelled");
  }
  if (!Number.isSafeInteger(bounded.deadlineEpochMilliseconds) || bounded.deadlineEpochMilliseconds <= Date.now()) {
    throw new Error("Hosted campaign deadline has expired");
  }
}

function resolveEnvironmentBindings(
  executable: HostedCampaignExecutableSpec,
  retainedEvidence: ReadonlyMap<string, unknown>,
): HostedCampaignExecutableSpec {
  if (executable.environmentBindings === undefined || executable.environmentBindings.length === 0) {
    return executable;
  }
  const resolved: Record<string, string> = { ...executable.environment };
  for (const binding of executable.environmentBindings) {
    const identity = actionReferenceIdentity(binding.valueFrom.actionRef);
    const evidence = retainedEvidence.get(identity);
    if (typeof evidence !== "object" || evidence === null) {
      throw new Error(`Hosted campaign child ${executable.childId} is missing bound evidence ${identity}`);
    }
    const value = (evidence as Record<string, unknown>)[binding.valueFrom.field];
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
      throw new Error(`Hosted campaign child ${executable.childId} bound ${binding.valueFrom.field} is invalid`);
    }
    resolved[binding.name] = value;
  }
  return Object.freeze({ ...executable, environment: Object.freeze(resolved) });
}

interface CampaignExecutionState {
  readonly completionFailures: Promise<never>[];
  readonly completionTasks: Promise<void>[];
  readonly handles: HostedCampaignChildHandle[];
  readonly retainedEvidence: Map<string, unknown>;
  readonly startedChildIds: Set<string>;
  barrierTeardownIncomplete: boolean;
  firstChildAuthorization?: (() => void) | undefined;
}

async function awaitBarrierOrCompletionFailure<Action extends HostedCampaignBarrierAction>(
  action: Action,
  ports: HostedCampaignPorts,
  bounded: HostedCampaignBoundedSignal,
  state: CampaignExecutionState,
): Promise<HostedCampaignActionEvidence<Action>> {
  const cancellation = new AbortController();
  const forwardCampaignAbort = () => { cancellation.abort(bounded.signal.reason); };
  if (bounded.signal.aborted) {
    forwardCampaignAbort();
  } else {
    bounded.signal.addEventListener("abort", forwardCampaignAbort, { once: true });
  }
  const barrier = Promise.resolve().then(async () => ports.awaitBarrier(action, {
    deadlineEpochMilliseconds: bounded.deadlineEpochMilliseconds,
    signal: cancellation.signal,
  }));
  try {
    return await Promise.race([barrier, ...state.completionFailures]);
  } finally {
    bounded.signal.removeEventListener("abort", forwardCampaignAbort);
    cancellation.abort(new Error(BARRIER_RACE_COMPLETED));
    // A losing poll owns resources until it observes cancellation. Do not let
    // campaign cleanup race ahead of cooperative teardown. A noncompliant
    // adapter that ignores abort quarantines the campaign lease instead.
    if (!await awaitBarrierTeardown(barrier)) {
      state.barrierTeardownIncomplete = true;
    }
  }
}

async function startChildren(
  input: HostedCampaignInput,
  ports: HostedCampaignPorts,
  bounded: HostedCampaignBoundedSignal,
  state: CampaignExecutionState,
  startBefore: HostedCampaignStartPoint,
): Promise<void> {
  const identity = startPointIdentity(startBefore);
  for (const executable of input.children.filter((child) => startPointIdentity(child.startBefore) === identity)) {
    if (state.startedChildIds.has(executable.childId)) {
      throw new Error(`Hosted campaign child would start more than once: ${executable.childId}`);
    }
    assertActive(bounded);
    const resolvedExecutable = resolveEnvironmentBindings(executable, state.retainedEvidence);
    if (state.firstChildAuthorization !== undefined) {
      state.firstChildAuthorization();
      state.firstChildAuthorization = undefined;
    }
    const handle = await ports.startChild(resolvedExecutable, bounded);
    state.handles.push(handle);
    if (handle.childId !== executable.childId) {
      throw new Error("Started child handle does not match its executable spec");
    }
    state.startedChildIds.add(executable.childId);
    if (executable.completion !== undefined) {
      const completion = ports.awaitChildCompletion(handle, resolvedExecutable, bounded);
      state.completionTasks.push(completion);
      state.completionFailures.push(completion.then(
        async () => new Promise<never>(() => {}),
        async (error: unknown) => {throw error;},
      ));
    }
  }
}

async function executeActions(
  input: HostedCampaignInput,
  ports: HostedCampaignPorts,
  bounded: HostedCampaignBoundedSignal,
  state: CampaignExecutionState,
  evidence: unknown[],
): Promise<void> {
  for (const reference of campaignActions(input)) {
    const { action } = reference;
    await startChildren(input, ports, bounded, state, { ...reference, kind: "barrier" });
    assertActive(bounded);
    const actionEvidence = await awaitBarrierOrCompletionFailure(
      action, ports, bounded, state,
    );
    validateActionEvidence(action, actionEvidence, input.thresholds);
    state.retainedEvidence.set(actionReferenceIdentity(reference), actionEvidence);
    evidence.push(Object.freeze({ action, evidence: actionEvidence }));
    for (const executable of input.children) {
      const phase = actorGatePhase(executable, reference);
      if (phase !== undefined) { await ports.publishReleaseGate(executable, phase, bounded); }
    }
    for (const executable of input.children) {
      const phase = supplementalGatePhase(executable, reference);
      if (phase !== undefined) { await ports.publishSupplementalGate(executable, phase, bounded); }
    }
  }
}

async function cleanupCampaign(
  handles: HostedCampaignChildHandle[],
  lease: HostedCampaignLeaseHandle | undefined,
  ports: HostedCampaignPorts,
  leaseQuarantined: boolean,
  failure: unknown,
): Promise<void> {
  const cleanupFailures: unknown[] = [];
  let childrenStopped = false;
  try {
    await stopEveryChild(handles, ports);
    childrenStopped = true;
  } catch (error) { cleanupFailures.push(error); }
  // The lease is also the quarantine for an incompletely reaped process tree.
  // Releasing it after any stop failure could admit a second campaign beside a
  // surviving child with the same external credentials and artifact scope.
  if (leaseQuarantined) {
    cleanupFailures.push(new Error("Hosted campaign barrier poll teardown did not settle after abort"));
  }
  if (lease !== undefined && childrenStopped && !leaseQuarantined) {
    try { await ports.releaseCampaignLease(lease); } catch (error) { cleanupFailures.push(error); }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, failure === undefined
      ? "Hosted campaign cleanup was incomplete"
      : "Hosted campaign failed and cleanup was incomplete",
    failure === undefined ? undefined : { cause: failure });
  }
}

export async function runHostedCampaign(
  input: HostedCampaignInput,
  ports: HostedCampaignPorts,
  bounded: HostedCampaignBoundedSignal,
  authorization?: HostedCampaignRuntimeAuthorization,
): Promise<HostedCampaignPassReceipt> {
  validateHostedCampaign(input);
  assertActive(bounded);
  const state: CampaignExecutionState = {
    barrierTeardownIncomplete: false, completionFailures: [], completionTasks: [], handles: [],
    retainedEvidence: new Map(), startedChildIds: new Set(),
  };
  const evidence: unknown[] = [];
  let lease: HostedCampaignLeaseHandle | undefined;
  let failure: unknown;
  try {
    const campaignId = input.runs[0]!.campaignId;
    lease = await ports.acquireCampaignLease(campaignId, bounded);
    if (lease.campaignId !== campaignId) { throw new Error("Acquired campaign lease does not match the campaign"); }
    if (authorization !== undefined) {
      const launchAuthorization = await authorization.authorizeAfterLease();
      state.firstChildAuthorization = () => { launchAuthorization.assertReadyForFirstChild(); };
    }
    await startChildren(input, ports, bounded, state, { kind: "campaign" });
    await executeActions(input, ports, bounded, state, evidence);
    await Promise.all(state.completionTasks);
  } catch (error) { failure = error; }
  await cleanupCampaign(state.handles, lease, ports, state.barrierTeardownIncomplete, failure);
  if (failure !== undefined) {throw failure instanceof Error
    ? failure : new Error("Hosted campaign failed", { cause: failure });}
  return Object.freeze({
    actionEvidence: Object.freeze(evidence), campaignId: input.runs[0]!.campaignId,
    runIds: [input.runs[0]!.runId, input.runs[1]!.runId, input.runs[2]!.runId] as const,
    schemaVersion: 1, teardownComplete: true,
  });
}
