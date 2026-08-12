import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, join } from "node:path";

import { HostedCampaignArtifactStore } from "./hosted-campaign-artifact-store.js";
import type {
  HostedCampaignBarrierAction,
  HostedCampaignBoundedSignal,
  HostedCampaignChildHandle,
  HostedCampaignExecutableSpec,
  HostedCampaignLeaseHandle,
  HostedCampaignPorts,
} from "./hosted-campaign-coordinator.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";
import { hostedCampaignProcessEventPrefix } from "./hosted-campaign-process-event.js";
import { ingestHostedCampaignProcessEventLine } from
  "./hosted-campaign-process-event-ingestion.js";
import { expectedHostedCampaignEventCorrelation } from
  "./hosted-campaign-process-event-correlation.js";
import { publishHostedCampaignCompletion } from "./hosted-campaign-completion-publisher.js";
import { signalHostedChildTree, waitForHostedChildTreeExit } from "./hosted-campaign-process-tree.js";
import {
  publishHostedActorGate,
  publishHostedSupplementalGate,
  type HostedActorGatePhase,
} from "./hosted-campaign-gate-publisher.js";
import {
  argumentsFor,
  entrypointFile,
  SSH_RUNTIME_ENTRYPOINTS,
  type HostedCampaignTrustedRuntimeEnvironment,
  validateChildEnvironment,
  validateHostedCampaignTrustedRuntimeEnvironment,
} from "./hosted-campaign-child-runtime.js";

interface ChildState {
  readonly child: ChildProcess; readonly childId: string; readonly closed: Promise<void>;
  readonly completionExpected: boolean; readonly exited: Promise<ChildExit>;
  readonly stdoutChunks: Buffer[]; readonly eventLines: string[]; readonly publishedEvents: Set<string>;
  eventIngestion: Promise<void>;
  stopping: boolean;
  termination?: Promise<void>;
  stdoutRemainder: string;
  failure?: Error;
  stderr: number;
  stdout: number;
}
interface ChildExit { readonly code: number | null; readonly signal: NodeJS.Signals | null }
export interface HostedCampaignProcessAdapterOptions {
  readonly artifactStore: HostedCampaignArtifactStore; readonly distRoot: string;
  readonly outputLimitBytes?: number; readonly terminationGraceMilliseconds?: number;
  readonly trustedRuntimeEnvironment: HostedCampaignTrustedRuntimeEnvironment;
}
export {
  type HostedCampaignTrustedRuntimeEnvironment,
  validateHostedCampaignTrustedRuntimeEnvironment,
} from "./hosted-campaign-child-runtime.js";

export class HostedCampaignProcessAdapter implements HostedCampaignPorts {
  readonly #children = new Map<string, ChildState>();
  readonly #options: HostedCampaignProcessAdapterOptions;
  readonly #trustedRuntimeEnvironment: HostedCampaignTrustedRuntimeEnvironment;
  constructor(options: HostedCampaignProcessAdapterOptions) {
    if (!isAbsolute(options.distRoot)) {
      throw new Error("Hosted campaign dist root must be absolute");
    }
    this.#options = options;
    this.#trustedRuntimeEnvironment = validateHostedCampaignTrustedRuntimeEnvironment(
      options.trustedRuntimeEnvironment,
    );
  }
  acquireCampaignLease(_campaignId: string, bounded: HostedCampaignBoundedSignal): Promise<HostedCampaignLeaseHandle> {
    return this.#options.artifactStore.acquireLease(bounded);
  }
  releaseCampaignLease(): Promise<void> { return this.#options.artifactStore.releaseLease(); }
  async publishReleaseGate(
    spec: HostedCampaignExecutableSpec,
    phaseOrBounded: HostedActorGatePhase | HostedCampaignBoundedSignal,
    explicitBounded?: HostedCampaignBoundedSignal,
  ): Promise<void> {
    const phase = typeof phaseOrBounded === "string" ? phaseOrBounded : "connection";
    const bounded = typeof phaseOrBounded === "string" ? explicitBounded : phaseOrBounded;
    if (bounded === undefined) { throw new Error("Hosted actor gate requires a bounded signal"); }
    assertPinnedTarget(spec);
    await publishHostedActorGate({ artifactStore: this.#options.artifactStore, bounded, phase, spec });
  }
  async publishSupplementalGate(
    spec: HostedCampaignExecutableSpec,
    phase: "connection" | "playback",
    bounded: HostedCampaignBoundedSignal,
  ): Promise<void> {
    assertPinnedTarget(spec);
    await publishHostedSupplementalGate({ bounded, phase, spec });
  }
  async awaitBarrier<Action extends HostedCampaignBarrierAction>(action: Action, bounded: HostedCampaignBoundedSignal) {
    this.#assertChildrenHealthy();
    const artifact = this.#options.artifactStore.awaitAction(action, bounded);
    const failures = [...this.#children.values()].filter(({ completionExpected }) => !completionExpected)
      .map(async (state) => {
        const { exited, childId } = state;
        const exit = await exited;
        await this.#settleChildState(state);
        if (state.failure !== undefined) {
          throw state.failure;
        }
        throw new Error(`Hosted campaign child ${childId} exited early (${String(exit.code ?? exit.signal)})`);
      });
    return Promise.race([artifact, ...failures]);
  }
  async awaitChildCompletion(
    handle: HostedCampaignChildHandle,
    spec: HostedCampaignExecutableSpec,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<void> {
    assertActive(bounded);
    const state = this.#children.get(handle.childId);
    if (state === undefined || spec.completion === undefined) {
      throw new Error(`Hosted campaign child ${handle.childId} has no pending completion`);
    }
    let exit: ChildExit;
    try {
      exit = await raceWithBounded(state.exited, bounded);
    } catch (error: unknown) {
      await this.#terminateChildTree(state);
      await raceWithTimeout(Promise.all([state.closed, state.eventIngestion]),
        Math.max(1_000, (this.#options.terminationGraceMilliseconds ?? 2_000) * 3),
        `Hosted campaign child ${handle.childId} cancellation cleanup timed out`);
      this.#children.delete(handle.childId);
      throw error;
    }
    // Once the finite child has exited within its deadline, teardown owns its
    // own bounded grace period. Reusing the caller deadline here can reject
    // between exit and publication and strand a valid completion under load.
    const finalizationMilliseconds = Math.max(
      1_000,
      (this.#options.terminationGraceMilliseconds ?? 2_000) * 3,
    );
    await raceWithTimeout(this.#finalizeExitedChild(state), finalizationMilliseconds,
      `Hosted campaign child ${handle.childId} finalization timed out`);
    this.#children.delete(handle.childId);
    if (state.failure !== undefined) {throw state.failure;}
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`Hosted campaign child ${handle.childId} failed (${String(exit.code ?? exit.signal)})`);
    }
    await raceWithTimeout(publishHostedCampaignCompletion({
      artifactStore: this.#options.artifactStore, childId: handle.childId,
      completion: spec.completion, stdoutChunks: state.stdoutChunks,
    }), finalizationMilliseconds, `Hosted campaign child ${handle.childId} completion publication timed out`);
  }
  async #finalizeExitedChild(state: ChildState): Promise<void> {
    await this.#terminateChildTree(state);
    await state.closed;
    await state.eventIngestion;
  }
  async startChild(spec: HostedCampaignExecutableSpec, bounded: HostedCampaignBoundedSignal): Promise<HostedCampaignChildHandle> {
    assertActive(bounded);
    if (this.#children.has(spec.childId)) {
      throw new Error(`Hosted campaign child already started: ${spec.childId}`);
    }
    assertPinnedTarget(spec);
    const environment = {
      ...(SSH_RUNTIME_ENTRYPOINTS.has(spec.entrypoint) ? this.#trustedRuntimeEnvironment : {}),
      ...validateChildEnvironment(spec.environment),
    };
    const child = spawn(process.execPath, [join(this.#options.distRoot, entrypointFile(spec.entrypoint)), ...argumentsFor(spec)], {
      detached: process.platform !== "win32", env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    let reportExit!: (exit: ChildExit) => void;
    const exited = new Promise<ChildExit>((resolve) => { reportExit = resolve; });
    let reportClosed!: () => void;
    const closed = new Promise<void>((resolve) => { reportClosed = resolve; });
    const state: ChildState = {
      child, childId: spec.childId, closed, completionExpected: spec.completion !== undefined,
      eventIngestion: Promise.resolve(), eventLines: [], exited,
      publishedEvents: new Set(), stderr: 0, stdout: 0, stdoutChunks: [], stdoutRemainder: "", stopping: false,
    };
    this.#children.set(spec.childId, state);
    const limit = this.#options.outputLimitBytes ?? 64 * 1024;
    child.stdout.on("data", (data: Buffer) => {
      state.stdout += data.byteLength;
      if (state.stdout <= limit) {state.stdoutChunks.push(data);}
      if (state.stdout > limit) {
        state.failure = new Error(`Hosted campaign child ${spec.childId} exceeded stdout limit`);
        void this.#terminateChildTree(state).catch((error: unknown) => {state.failure ??= asError(error);});
        return;
      }
      this.#ingestEventOutput(state, spec, data);
    });
    child.stderr.on("data", (data: Buffer) => {
      state.stderr += data.byteLength;
      if (state.stderr > limit) {
        state.failure = new Error(`Hosted campaign child ${spec.childId} exceeded stderr limit`);
        void this.#terminateChildTree(state).catch((error: unknown) => {state.failure ??= asError(error);});
      }
    });
    child.once("exit", (code, signal) => {
      if (spec.completion === undefined && !state.stopping) {
        state.failure ??= new Error(`Hosted campaign child ${spec.childId} exited early (${String(code ?? signal)})`);
      }
      reportExit({ code, signal });
    });
    child.once("close", () => {
      if (state.stdoutRemainder.startsWith(hostedCampaignProcessEventPrefix)) {
        state.failure ??= new Error(`Hosted campaign child ${spec.childId} produced a truncated prefixed event`);
      }
      reportClosed();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error: unknown) {
      state.failure ??= asError(error);
      await this.#settleChildState(state);
      this.#children.delete(spec.childId);
      throw state.failure;
    }
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    if (state.failure !== undefined) {
      await this.#settleChildState(state);
      this.#children.delete(spec.childId);
      throw state.failure;
    }
    return { childId: spec.childId } as HostedCampaignChildHandle;
  }
  #ingestEventOutput(state: ChildState, spec: HostedCampaignExecutableSpec, data: Buffer): void {
    if (state.failure !== undefined) {return;}
    state.stdoutRemainder += data.toString("utf8");
    const lines = state.stdoutRemainder.split("\n");
    state.stdoutRemainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith(hostedCampaignProcessEventPrefix)) {continue;}
      try {
        const expected = expectedHostedCampaignEventCorrelation(spec);
        state.eventLines.push(line);
        state.eventIngestion = appendEventIngestion(state.eventIngestion, {
          campaignId: expected.campaignId, line, publishedEvents: state.publishedEvents,
          declaredProductions: spec.produces,
          runId: expected.runId, store: this.#options.artifactStore,
        })
          .catch((error: unknown) => {
            state.failure = new Error(
              `Hosted campaign child ${spec.childId} produced invalid prefixed event`,
              { cause: error },
            );
            void this.#terminateChildTree(state).catch((terminationError: unknown) => {
              state.failure ??= asError(terminationError);
            });
          });
      } catch (error: unknown) {
        state.failure = new Error(`Hosted campaign child ${spec.childId} produced invalid prefixed event`, {
          cause: error,
        });
        void this.#terminateChildTree(state).catch((terminationError: unknown) => {
          state.failure ??= asError(terminationError);
        });
        return;
      }
    }
  }
  async stopChild(handle: HostedCampaignChildHandle): Promise<void> {
    const state = this.#children.get(handle.childId);
    if (state === undefined) {
      return;
    }
    await this.#settleChildState(state);
    this.#children.delete(handle.childId);
    if (state.failure !== undefined) {throw state.failure;}
  }
  async #settleChildState(state: ChildState): Promise<void> {
    await this.#terminateChildTree(state);
    await state.closed;
    await state.eventIngestion;
  }
  #terminateChildTree(state: ChildState): Promise<void> {
    state.termination ??= this.#terminateChildTreeOnce(state);
    return state.termination;
  }
  async #terminateChildTreeOnce(state: ChildState): Promise<void> {
    const grace = this.#options.terminationGraceMilliseconds ?? 2_000;
    state.stopping = true;
    signalHostedChildTree(state.child, "SIGTERM");
    if (!await waitForHostedChildTreeExit(state.child, grace)) {
      signalHostedChildTree(state.child, "SIGKILL");
      if (!await waitForHostedChildTreeExit(state.child, grace)) {
        throw new Error(`Hosted campaign child ${state.childId} process group survived SIGKILL`);
      }
    }
  }
  #assertChildrenHealthy(): void {
    const childFailure = [...this.#children.values()]
      .find(({ completionExpected, failure }) => !completionExpected && failure !== undefined)?.failure;
    if (childFailure !== undefined) {
      throw childFailure;
    }
  }
}

async function appendEventIngestion(
  previous: Promise<void>,
  input: Parameters<typeof ingestHostedCampaignProcessEventLine>[0],
): Promise<void> {
  await previous;
  await ingestHostedCampaignProcessEventLine(input);
}

async function raceWithBounded<T>(promise: Promise<T>, bounded: HostedCampaignBoundedSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const remaining = bounded.deadlineEpochMilliseconds - Date.now();
    if (remaining <= 0) { reject(new Error("Hosted campaign deadline expired")); return; }
    const timer = setTimeout(() => { reject(new Error("Hosted campaign deadline expired")); }, remaining);
    const abort = (): void => { reject(bounded.signal.reason ?? new Error("Hosted campaign cancelled")); };
    bounded.signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      bounded.signal.removeEventListener("abort", abort);
    });
  });
}

async function raceWithTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message)); }, milliseconds);
    void promise.then(resolve, reject).finally(() => { clearTimeout(timer); });
  });
}
function assertPinnedTarget(spec: HostedCampaignExecutableSpec): void {
  const expected = HOSTED_CAMPAIGN_TARGET;
  if (spec.entrypoint === "actor") {
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_GUILD_ID", expected.guildId);
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_VOICE_CHANNEL_ID", expected.voiceChannelId);
    const declaredReleaseGatePath = spec.environment.DISCORD_E2E_HOSTED_RELEASE_GATE_PATH;
    if ((declaredReleaseGatePath !== undefined || spec.releaseGate !== undefined)
      && declaredReleaseGatePath !== spec.releaseGate?.path) {
      throw new Error(`Hosted campaign actor ${spec.childId} release gate path mismatch`);
    }
  }
  if (spec.entrypoint === "live-observer") {
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_LIVE_RESULT_CHANNEL_ID", expected.publicationChannelId);
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_LIVE_SUT_APPLICATION_ID", expected.sutApplicationId);
  }
  if (spec.entrypoint === "collector" || spec.entrypoint === "provenance-probe") {
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_MUTATION_TARGET", expected.mutationTarget);
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_REMOTE_HOST", expected.host);
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_REMOTE_PROJECT", expected.project);
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_REMOTE_CRAIG_PROJECT", expected.craigProject);
  }
  if (spec.entrypoint === "replay-attestation-publisher") {
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_REPLAY_MUTATION_TARGET", expected.mutationTarget);
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_REPLAY_REMOTE_HOST", expected.host);
  }
}
function assertEnvironmentCoordinate(
  spec: HostedCampaignExecutableSpec, name: string, expected: string,
): void {
  if (spec.environment[name] !== expected) {
    throw new Error(`Hosted campaign child ${spec.childId} target mismatch for ${name}`);
  }
}
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
function assertActive(bounded: HostedCampaignBoundedSignal): void {
  if (bounded.signal.aborted) {
    throw bounded.signal.reason ?? new Error("Hosted campaign cancelled");
  }
  if (Date.now() >= bounded.deadlineEpochMilliseconds) {
    throw new Error("Hosted campaign deadline expired");
  }
}
