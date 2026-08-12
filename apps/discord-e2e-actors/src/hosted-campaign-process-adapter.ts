import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { HostedCampaignArtifactStore } from "./hosted-campaign-artifact-store.js";
import type {
  HostedCampaignBarrierAction,
  HostedCampaignBoundedSignal,
  HostedCampaignChildHandle,
  HostedCampaignEntrypoint,
  HostedCampaignExecutableSpec,
  HostedCampaignLeaseHandle,
  HostedCampaignPorts,
} from "./hosted-campaign-coordinator.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";

const ENTRYPOINTS: Readonly<Record<HostedCampaignEntrypoint, string>> = Object.freeze({
  actor: "main.js",
  "campaign-verifier": "verify-campaign.js",
  collector: "collect-retained-evidence.js",
  "conversation-observer": "observe-conversation-voice.js",
  "evidence-verifier": "verify-retained-evidence.js",
  "live-observer": "observe-live-discord.js",
  "recording-ready": "collect-recording-ready-receipt.js",
  "supplemental-player": "play-supplemental-voice.js",
});

const ALLOWED_ENVIRONMENT = new Set([
  "DISCORD_E2E_ACTOR_RUN_INPUT", "DISCORD_E2E_ACTOR_RUN_OUTPUT", "DISCORD_E2E_BOTIK_SPEAKER_ID",
  "DISCORD_E2E_CONVERSATION_CAMPAIGN_PROOF_INPUT", "DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON",
  "DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID", "DISCORD_E2E_CONVERSATION_VOICE_CAMPAIGN_PROOF_OUTPUT",
  "DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS", "DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID",
  "DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS", "DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_TOLERANCE_MS",
  "DISCORD_E2E_CONVERSATION_VOICE_GUILD_ID", "DISCORD_E2E_CONVERSATION_VOICE_INPUTS",
  "DISCORD_E2E_CONVERSATION_VOICE_KEYCHAIN_SERVICE", "DISCORD_E2E_CONVERSATION_VOICE_MAX_PCM_BYTES",
  "DISCORD_E2E_CONVERSATION_VOICE_MEETING_ID", "DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_ACCOUNT",
  "DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID", "DISCORD_E2E_CONVERSATION_VOICE_OUTPUT",
  "DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT", "DISCORD_E2E_CONVERSATION_VOICE_PRIVATE_TEST_GUILD",
  "DISCORD_E2E_CONVERSATION_VOICE_PURPOSE", "DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS",
  "DISCORD_E2E_CONVERSATION_VOICE_RECORDING_ID", "DISCORD_E2E_CONVERSATION_VOICE_RUN_ID",
  "DISCORD_E2E_CONVERSATION_VOICE_SECRET_DIRECTORY", "DISCORD_E2E_CONVERSATION_VOICE_TURN_ID",
  "DISCORD_E2E_CONVERSATION_VOICE_VOICE_CHANNEL_ID", "DISCORD_E2E_EVIDENCE_OUTPUT",
  "DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION", "DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION",
  "DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION", "DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION",
  "DISCORD_E2E_FIXTURE_MANIFEST", "DISCORD_E2E_GUILD_ID", "DISCORD_E2E_KEYCHAIN_SERVICE",
  "DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID", "DISCORD_E2E_HOSTED_RELEASE_GATE_PATH",
  "DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS",
  "DISCORD_E2E_LIVE_DURATION_MS", "DISCORD_E2E_LIVE_KEYCHAIN_SERVICE", "DISCORD_E2E_LIVE_OUTPUT",
  "DISCORD_E2E_LIVE_POLL_INTERVAL_MS", "DISCORD_E2E_LIVE_RESULT_CHANNEL_ID", "DISCORD_E2E_LIVE_RUN_ID",
  "DISCORD_E2E_LIVE_SECRET_DIRECTORY", "DISCORD_E2E_LIVE_SUT_ACCOUNT", "DISCORD_E2E_LIVE_SUT_APPLICATION_ID",
  "DISCORD_E2E_MUTATION_TARGET", "DISCORD_E2E_PLAYBACK_TIMEOUT_MS", "DISCORD_E2E_POST_PLAYBACK_HOLD_MS",
  "DISCORD_E2E_PRE_PLAYBACK_HOLD_MS", "DISCORD_E2E_READY_TIMEOUT_MS", "DISCORD_E2E_RECORDER_BOT_ID",
  "DISCORD_E2E_READY_RECEIPT_INPUT", "DISCORD_E2E_READY_RECEIPT_OUTPUT",
  "DISCORD_E2E_RECORDING_ID", "DISCORD_E2E_RECORDING_PLAYBACK_ORIGIN", "DISCORD_E2E_RECORDING_PLAYBACK_READINESS",
  "DISCORD_E2E_RECORDING_PLAYBACK_TEST_SCOPE", "DISCORD_E2E_REMOTE_ATTESTATION_FILE", "DISCORD_E2E_REMOTE_COMPOSE_FILE",
  "DISCORD_E2E_REMOTE_CRAIG_PROJECT", "DISCORD_E2E_REMOTE_CRAIG_SERVICE", "DISCORD_E2E_REMOTE_ENV_FILE",
  "DISCORD_E2E_REMOTE_HOST", "DISCORD_E2E_REMOTE_PROJECT", "DISCORD_E2E_REMOTE_SOURCE_ROOT", "DISCORD_E2E_RUN_ID",
  "DISCORD_E2E_SCENARIO", "DISCORD_E2E_SECRET_DIRECTORY", "DISCORD_E2E_SERVICE_LEVELS_INPUT",
  "DISCORD_E2E_SERVICE_LEVEL_THRESHOLDS_INPUT", "DISCORD_E2E_SPEAKER_A_ACCOUNT", "DISCORD_E2E_SPEAKER_A_FIXTURE",
  "DISCORD_E2E_SPEAKER_B_ACCOUNT", "DISCORD_E2E_SPEAKER_B_CONNECT_DELAY_MS", "DISCORD_E2E_SPEAKER_B_DELAY_MS",
  "DISCORD_E2E_SPEAKER_B_FIXTURE", "DISCORD_E2E_SUPPLEMENTAL_EVIDENCE_OUTPUT", "DISCORD_E2E_SUPPLEMENTAL_KEYCHAIN_ACCOUNT",
  "DISCORD_E2E_SUPPLEMENTAL_KEYCHAIN_SERVICE", "DISCORD_E2E_SUPPLEMENTAL_MANIFEST",
  "DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT", "DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_TIMEOUT_MS",
  "DISCORD_E2E_SUPPLEMENTAL_POST_HOLD_MS", "DISCORD_E2E_SUPPLEMENTAL_PRE_HOLD_MS",
  "DISCORD_E2E_SUPPLEMENTAL_PRIVATE_TEST_GUILD", "DISCORD_E2E_SUPPLEMENTAL_READY_TIMEOUT_MS",
  "DISCORD_E2E_SUPPLEMENTAL_RUN_ID", "DISCORD_E2E_SUPPLEMENTAL_SECRET_DIRECTORY", "DISCORD_E2E_SUT_ACCOUNT",
  "DISCORD_E2E_VOICE_CHANNEL_ID",
]);

interface ChildState {
  readonly child: ChildProcess;
  readonly childId: string;
  readonly closed: Promise<void>;
  readonly exited: Promise<ChildExit>;
  readonly stdoutChunks: Buffer[];
  failure?: Error;
  stderr: number;
  stdout: number;
}
interface ChildExit { readonly code: number | null; readonly signal: NodeJS.Signals | null }

const evidenceVerificationOutputSchema = z.object({
  failures: z.array(z.unknown()), metrics: z.array(z.unknown()), passed: z.literal(true),
}).strict();
const campaignVerificationOutputSchema = z.object({
  failures: z.array(z.unknown()), passed: z.literal(true),
  runResults: z.record(z.string(), z.object({
    failures: z.array(z.unknown()), metrics: z.array(z.unknown()), passed: z.literal(true),
  }).strict()),
}).strict();
const collectorOutputSchema = z.object({
  evidencePath: z.string(), metrics: z.array(z.unknown()), recordingId: z.string(),
  runId: z.string(), status: z.literal("passed"),
}).strict();
export interface HostedCampaignProcessAdapterOptions {
  readonly artifactStore: HostedCampaignArtifactStore;
  readonly distRoot: string;
  readonly outputLimitBytes?: number;
  readonly terminationGraceMilliseconds?: number;
}

export class HostedCampaignProcessAdapter implements HostedCampaignPorts {
  readonly #children = new Map<string, ChildState>();
  readonly #options: HostedCampaignProcessAdapterOptions;
  constructor(options: HostedCampaignProcessAdapterOptions) {
    if (!isAbsolute(options.distRoot)) {
      throw new Error("Hosted campaign dist root must be absolute");
    }
    this.#options = options;
  }
  acquireCampaignLease(_campaignId: string, bounded: HostedCampaignBoundedSignal): Promise<HostedCampaignLeaseHandle> {
    return this.#options.artifactStore.acquireLease(bounded);
  }
  releaseCampaignLease(): Promise<void> { return this.#options.artifactStore.releaseLease(); }
  async publishReleaseGate(spec: HostedCampaignExecutableSpec, bounded: HostedCampaignBoundedSignal): Promise<void> {
    assertActive(bounded);
    assertPinnedTarget(spec);
    const path = spec.environment.DISCORD_E2E_HOSTED_RELEASE_GATE_PATH;
    const campaignId = spec.environment.DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID;
    const runId = spec.environment.DISCORD_E2E_RUN_ID;
    const scenario = spec.environment.DISCORD_E2E_SCENARIO;
    if (path === undefined || !isAbsolute(path) || campaignId === undefined || runId === undefined
      || !new Set(["sequential", "overlap", "reconnect"]).has(scenario ?? "")) {
      throw new Error(`Hosted campaign actor ${spec.childId} has an incomplete release gate contract`);
    }
    await this.#options.artifactStore.writeCreateOnly(path, {
      schemaVersion: 1, campaignId, runId, scenario, releasedAtEpochMs: Date.now(),
      target: { guildId: "1533228590643155034", voiceChannelId: "1533228823045214398", mutationTarget: "test-only" },
    });
  }
  async awaitBarrier<Action extends HostedCampaignBarrierAction>(action: Action, bounded: HostedCampaignBoundedSignal) {
    this.#assertChildrenHealthy();
    const artifact = this.#options.artifactStore.awaitAction(action, bounded);
    const failures = [...this.#children.values()].map(async ({ exited, childId }) => {
      const exit = await exited;
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
    const exit = await raceWithBounded(state.exited, bounded);
    await raceWithBounded(state.closed, bounded);
    this.#children.delete(handle.childId);
    if (state.failure !== undefined) {throw state.failure;}
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`Hosted campaign child ${handle.childId} failed (${String(exit.code ?? exit.signal)})`);
    }
    const output = parseJsonOutput(state.stdoutChunks, handle.childId);
    const completion = spec.completion;
    if (completion.kind === "collector") {
      const parsed = collectorOutputSchema.parse(output);
      if (parsed.evidencePath !== completion.evidencePath || parsed.runId !== completion.runId) {
        throw new Error(`Hosted campaign collector ${handle.childId} output correlation mismatch`);
      }
      await this.#options.artifactStore.publishAction(completion.action, {
        ordinal: completion.action.ordinal, runId: completion.action.runId, verified: true,
      });
      return;
    }
    if (completion.kind === "evidence-verifier") {
      evidenceVerificationOutputSchema.parse(output);
      await this.#options.artifactStore.publishAction(completion.action, {
        ordinal: completion.action.ordinal, runId: completion.action.runId, verified: true,
      });
      return;
    }
    const parsed = campaignVerificationOutputSchema.parse(output);
    if (JSON.stringify(Object.keys(parsed.runResults).toSorted()) !== JSON.stringify(completion.runIds.toSorted())) {
      throw new Error(`Hosted campaign verifier ${handle.childId} run results mismatch`);
    }
    await this.#options.artifactStore.publishAction(completion.action, { campaignId: completion.campaignId });
  }
  async startChild(spec: HostedCampaignExecutableSpec, bounded: HostedCampaignBoundedSignal): Promise<HostedCampaignChildHandle> {
    assertActive(bounded);
    if (this.#children.has(spec.childId)) {
      throw new Error(`Hosted campaign child already started: ${spec.childId}`);
    }
    assertPinnedTarget(spec);
    const environment = validateEnvironment(spec.environment);
    const child = spawn(process.execPath, [join(this.#options.distRoot, ENTRYPOINTS[spec.entrypoint]), ...argumentsFor(spec)], {
      env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    let reportExit!: (exit: ChildExit) => void;
    const exited = new Promise<ChildExit>((resolve) => { reportExit = resolve; });
    let reportClosed!: () => void;
    const closed = new Promise<void>((resolve) => { reportClosed = resolve; });
    const state: ChildState = { child, childId: spec.childId, closed, exited, stderr: 0, stdout: 0, stdoutChunks: [] };
    this.#children.set(spec.childId, state);
    const limit = this.#options.outputLimitBytes ?? 64 * 1024;
    child.stdout?.on("data", (data: Buffer) => {
      state.stdout += data.byteLength;
      if (state.stdout <= limit) {state.stdoutChunks.push(data);}
      if (state.stdout > limit) {
        state.failure = new Error(`Hosted campaign child ${spec.childId} exceeded stdout limit`);
        child.kill("SIGTERM");
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      state.stderr += data.byteLength;
      if (state.stderr > limit) {
        state.failure = new Error(`Hosted campaign child ${spec.childId} exceeded stderr limit`);
        child.kill("SIGTERM");
      }
    });
    child.once("exit", (code, signal) => {
      if (spec.completion === undefined) {
        state.failure ??= new Error(`Hosted campaign child ${spec.childId} exited early (${String(code ?? signal)})`);
      }
      reportExit({ code, signal });
    });
    child.once("close", reportClosed);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    if (state.failure !== undefined) {
      this.#children.delete(spec.childId);
      throw state.failure;
    }
    return { childId: spec.childId } as HostedCampaignChildHandle;
  }
  async stopChild(handle: HostedCampaignChildHandle): Promise<void> {
    const state = this.#children.get(handle.childId);
    if (state === undefined) {
      return;
    }
    this.#children.delete(handle.childId);
    if (state.child.exitCode !== null || state.child.signalCode !== null) {
      return;
    }
    state.child.kill("SIGTERM");
    const exited = await waitForExit(state.child, this.#options.terminationGraceMilliseconds ?? 2_000);
    if (!exited) {
      state.child.kill("SIGKILL");
      await waitForExit(state.child, this.#options.terminationGraceMilliseconds ?? 2_000);
    }
  }
  #assertChildrenHealthy(): void {
    const childFailure = [...this.#children.values()].find(({ failure }) => failure !== undefined)?.failure;
    if (childFailure !== undefined) {
      throw childFailure;
    }
  }
}

function parseJsonOutput(chunks: readonly Buffer[], childId: string): unknown {
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error(`Hosted campaign child ${childId} produced malformed completion output`);
  }
}

async function raceWithBounded<T>(promise: Promise<T>, bounded: HostedCampaignBoundedSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const remaining = bounded.deadlineEpochMilliseconds - Date.now();
    if (remaining <= 0) { reject(new Error("Hosted campaign deadline expired")); return; }
    const timer = setTimeout(() => reject(new Error("Hosted campaign deadline expired")), remaining);
    const abort = () => reject(bounded.signal.reason ?? new Error("Hosted campaign cancelled"));
    bounded.signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      bounded.signal.removeEventListener("abort", abort);
    });
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
  if (spec.entrypoint === "collector") {
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_MUTATION_TARGET", expected.mutationTarget);
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_REMOTE_HOST", expected.host);
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_REMOTE_PROJECT", expected.project);
    assertEnvironmentCoordinate(spec, "DISCORD_E2E_REMOTE_CRAIG_PROJECT", expected.craigProject);
  }
}

function assertEnvironmentCoordinate(
  spec: HostedCampaignExecutableSpec, name: string, expected: string,
): void {
  if (spec.environment[name] !== expected) {
    throw new Error(`Hosted campaign child ${spec.childId} target mismatch for ${name}`);
  }
}

function argumentsFor(spec: HostedCampaignExecutableSpec): readonly string[] {
  const args = spec.arguments;
  if (args.kind === "environment") {
    return [];
  }
  if (args.kind === "evidence-verifier") {
    return [args.manifestPath, args.evidencePath, ...(args.thresholdsPath === undefined ? [] : [args.thresholdsPath])];
  }
  return [args.manifestPath, ...args.evidencePaths, ...(args.thresholdsPath === undefined ? [] : ["--service-level-thresholds", args.thresholdsPath])];
}
function validateEnvironment(environment: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (name === "PATH" || name === "NODE_OPTIONS" || name.startsWith("LD_") || name.startsWith("DYLD_")
      || name.includes("TOKEN") || !ALLOWED_ENVIRONMENT.has(name)) {
      throw new Error(`Hosted campaign child environment variable is forbidden: ${name}`);
    }
    clean[name] = value;
  }
  return clean;
}
function assertActive(bounded: HostedCampaignBoundedSignal): void {
  if (bounded.signal.aborted) {
    throw bounded.signal.reason ?? new Error("Hosted campaign cancelled");
  }
  if (Date.now() >= bounded.deadlineEpochMilliseconds) {
    throw new Error("Hosted campaign deadline expired");
  }
}
async function waitForExit(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(false), milliseconds);
    child.once("exit", () => {
      clearTimeout(timer);
      finish(true);
    });
  });
}
