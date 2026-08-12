import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";

/* oxlint-disable max-lines */

import { z } from "zod";

import { HostedCampaignArtifactStore } from "./hosted-campaign-artifact-store.js";
import {
  hostedServiceLevelSourceReportV1Schema,
  readPrivateHostedServiceLevelArtifact,
} from "./hosted-service-level-source-artifact.js";
import { writeSupplementalPlaybackGate } from "./supplemental-playback-gate.js";
import { verifyHostedFiniteProcessCompletion } from "./hosted-finite-process-completion.js";
import { recordingReadyReceiptV1Schema } from "./recording-ready-receipt.js";
import type { HostedFiniteProcessCompletion } from "./hosted-finite-process-contract.js";
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
import { hostedCampaignProcessEventPrefix } from "./hosted-campaign-process-event.js";
import { ingestHostedCampaignProcessEventLine } from
  "./hosted-campaign-process-event-ingestion.js";
import { expectedHostedCampaignEventCorrelation } from
  "./hosted-campaign-process-event-correlation.js";
import { hostedCampaignProvenanceCompletionV1Schema } from "./hosted-campaign-provenance.js";
import { verifyHostedServiceLevelCompletion } from "./hosted-service-level-completion.js";

const ENTRYPOINTS: Readonly<Record<HostedCampaignEntrypoint, string>> = Object.freeze({
  actor: "main.js",
  "campaign-verifier": "verify-campaign.js",
  collector: "collect-retained-evidence.js",
  "conversation-observer": "observe-conversation-voice.js",
  "evidence-verifier": "verify-retained-evidence.js",
  "live-observer": "observe-live-discord.js",
  "playback-link-observer": "observe-live-discord-playback-link.js",
  "provenance-probe": "collect-hosted-campaign-provenance.js",
  "recording-ready": "collect-recording-ready-receipt.js",
  "replay-attestation-publisher": "publish-replay-attestation.js",
  "service-level-sources": "collect-hosted-service-level-sources.js",
  "service-levels": "collect-hosted-service-levels.js",
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
  "DISCORD_E2E_HOSTED_CAMPAIGN_ID",
  "DISCORD_E2E_LIVE_DURATION_MS", "DISCORD_E2E_LIVE_KEYCHAIN_SERVICE", "DISCORD_E2E_LIVE_OUTPUT",
  "DISCORD_E2E_LIVE_POLL_INTERVAL_MS", "DISCORD_E2E_LIVE_RESULT_CHANNEL_ID", "DISCORD_E2E_LIVE_RUN_ID",
  "DISCORD_E2E_LIVE_SECRET_DIRECTORY", "DISCORD_E2E_LIVE_SUT_ACCOUNT", "DISCORD_E2E_LIVE_SUT_APPLICATION_ID",
  "DISCORD_E2E_MUTATION_TARGET", "DISCORD_E2E_PLAYBACK_TIMEOUT_MS", "DISCORD_E2E_POST_PLAYBACK_HOLD_MS",
  "DISCORD_E2E_PLAYBACK_LINK_DURATION_MS", "DISCORD_E2E_PLAYBACK_LINK_KEYCHAIN_SERVICE",
  "DISCORD_E2E_PLAYBACK_LINK_MODE",
  "DISCORD_E2E_PLAYBACK_LINK_OUTPUT", "DISCORD_E2E_PLAYBACK_LINK_POLL_INTERVAL_MS",
  "DISCORD_E2E_PLAYBACK_LINK_PROJECTION_CONTAINER_JSON", "DISCORD_E2E_PLAYBACK_LINK_PROJECTION_MARKER",
  "DISCORD_E2E_PLAYBACK_LINK_MEETING_ID",
  "DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID", "DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID",
  "DISCORD_E2E_PLAYBACK_LINK_RUN_ID", "DISCORD_E2E_PLAYBACK_LINK_SECRET_DIRECTORY",
  "DISCORD_E2E_PLAYBACK_LINK_SUT_ACCOUNT", "DISCORD_E2E_PLAYBACK_LINK_SUT_APPLICATION_ID",
  "DISCORD_E2E_PRE_PLAYBACK_HOLD_MS", "DISCORD_E2E_READY_TIMEOUT_MS", "DISCORD_E2E_RECORDER_BOT_ID",
  "DISCORD_E2E_PROVENANCE_CAMPAIGN_ID", "DISCORD_E2E_PROVENANCE_PHASE", "DISCORD_E2E_PROVENANCE_RUN_IDS_JSON",
  "DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH",
  "DISCORD_E2E_REPLAY_FIXTURE_MANIFEST", "DISCORD_E2E_REPLAY_MUTATION_TARGET",
  "DISCORD_E2E_REPLAY_RECORDING_ID", "DISCORD_E2E_REPLAY_REMOTE_ATTESTATION_FILE",
  "DISCORD_E2E_REPLAY_REMOTE_COMPOSE_FILE", "DISCORD_E2E_REPLAY_REMOTE_ENV_FILE",
  "DISCORD_E2E_REPLAY_REMOTE_HOST", "DISCORD_E2E_REPLAY_REMOTE_SOURCE_ROOT", "DISCORD_E2E_REPLAY_RUN_ID",
  "DISCORD_E2E_READY_RECEIPT_INPUT", "DISCORD_E2E_READY_RECEIPT_OUTPUT",
  "DISCORD_E2E_READY_RECEIPT_POLL_INTERVAL_MS", "DISCORD_E2E_READY_RECEIPT_TIMEOUT_MS",
  "DISCORD_E2E_RECORDING_ID", "DISCORD_E2E_RECORDING_PLAYBACK_ORIGIN", "DISCORD_E2E_RECORDING_PLAYBACK_READINESS",
  "DISCORD_E2E_RECORDING_PLAYBACK_TEST_SCOPE", "DISCORD_E2E_REMOTE_ATTESTATION_FILE", "DISCORD_E2E_REMOTE_COMPOSE_FILE",
  "DISCORD_E2E_REMOTE_CRAIG_PROJECT", "DISCORD_E2E_REMOTE_CRAIG_SERVICE", "DISCORD_E2E_REMOTE_ENV_FILE",
  "DISCORD_E2E_REMOTE_HOST", "DISCORD_E2E_REMOTE_PROJECT", "DISCORD_E2E_REMOTE_SOURCE_ROOT", "DISCORD_E2E_RUN_ID",
  "DISCORD_E2E_SCENARIO", "DISCORD_E2E_SECRET_DIRECTORY", "DISCORD_E2E_SERVICE_LEVELS_INPUT",
  "DISCORD_E2E_SLA_CAMPAIGN_ID", "DISCORD_E2E_SLA_CAMPAIGN_PROOF_INPUT",
  "DISCORD_E2E_SLA_CLOCK_ATTESTATIONS_INPUT", "DISCORD_E2E_SLA_CLOCK_PREFLIGHT_INPUT", "DISCORD_E2E_SLA_DATABASE_INPUT",
  "DISCORD_E2E_SLA_FIXTURE_MANIFEST_INPUT", "DISCORD_E2E_SLA_MEETING_ID",
  "DISCORD_E2E_SLA_MEETING_PLATFORM_LOG_INPUT", "DISCORD_E2E_SLA_OUTPUT",
  "DISCORD_E2E_SLA_PLAYBACK_LINK_PROOF_INPUT", "DISCORD_E2E_SLA_READY_RECEIPT_INPUT",
  "DISCORD_E2E_SLA_RECORDING_ID", "DISCORD_E2E_SLA_REPORT_OUTPUT", "DISCORD_E2E_SLA_RUN_ID",
  "DISCORD_E2E_SLA_SOURCE_REPORT_OUTPUT",
  "DISCORD_E2E_SLA_S3_INPUT", "DISCORD_E2E_SLA_SUPPLEMENTAL_PLAYBACK_INPUT",
  "DISCORD_E2E_SLA_VOICE_INPUTS",
  "DISCORD_E2E_SERVICE_LEVEL_THRESHOLDS_INPUT", "DISCORD_E2E_SPEAKER_A_ACCOUNT", "DISCORD_E2E_SPEAKER_A_FIXTURE",
  "DISCORD_E2E_SPEAKER_B_ACCOUNT", "DISCORD_E2E_SPEAKER_B_CONNECT_DELAY_MS", "DISCORD_E2E_SPEAKER_B_DELAY_MS",
  "DISCORD_E2E_SPEAKER_B_FIXTURE", "DISCORD_E2E_SUPPLEMENTAL_EVIDENCE_OUTPUT", "DISCORD_E2E_SUPPLEMENTAL_KEYCHAIN_ACCOUNT",
  "DISCORD_E2E_SUPPLEMENTAL_CAMPAIGN_ID", "DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_PATH",
  "DISCORD_E2E_SUPPLEMENTAL_GATE_TIMEOUT_MS", "DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_PATH",
  "DISCORD_E2E_SUPPLEMENTAL_KEYCHAIN_SERVICE", "DISCORD_E2E_SUPPLEMENTAL_MANIFEST",
  "DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT", "DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_TIMEOUT_MS",
  "DISCORD_E2E_SUPPLEMENTAL_POST_HOLD_MS", "DISCORD_E2E_SUPPLEMENTAL_PRE_HOLD_MS",
  "DISCORD_E2E_SUPPLEMENTAL_PRIVATE_TEST_GUILD", "DISCORD_E2E_SUPPLEMENTAL_READY_TIMEOUT_MS",
  "DISCORD_E2E_SUPPLEMENTAL_RUN_ID", "DISCORD_E2E_SUPPLEMENTAL_SECRET_DIRECTORY", "DISCORD_E2E_SUT_ACCOUNT",
  "DISCORD_E2E_VOICE_CHANNEL_ID",
]);
const TRUSTED_RUNTIME_ENVIRONMENT_NAMES = new Set(["HOME", "LANG", "LC_ALL", "PATH", "SSH_AUTH_SOCK"]);
const SSH_RUNTIME_ENTRYPOINTS: ReadonlySet<HostedCampaignEntrypoint> = new Set([
  "collector",
  "provenance-probe",
  "recording-ready",
  "replay-attestation-publisher",
  "service-level-sources",
]);

interface ChildState {
  readonly child: ChildProcess;
  readonly childId: string;
  readonly closed: Promise<void>;
  readonly completionExpected: boolean;
  readonly exited: Promise<ChildExit>;
  readonly stdoutChunks: Buffer[];
  readonly eventLines: string[];
  readonly publishedEvents: Set<string>;
  eventIngestion: Promise<void>;
  stopping: boolean;
  termination?: Promise<void>;
  stdoutRemainder: string;
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
  readonly trustedRuntimeEnvironment: HostedCampaignTrustedRuntimeEnvironment;
}

export interface HostedCampaignTrustedRuntimeEnvironment {
  readonly HOME: string;
  readonly LANG?: string;
  readonly LC_ALL?: string;
  readonly PATH: string;
  readonly SSH_AUTH_SOCK?: string;
}

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
    if (staged?.armedPath !== undefined) {
      await waitForActorGateArmed({
        armedPath: staged.armedPath, campaignId, path, phase, runId,
        scenario: scenario as "overlap" | "reconnect" | "sequential",
      }, bounded.signal);
    }
    await this.#options.artifactStore.writeCreateOnly(path, {
      schemaVersion: 1, campaignId, runId, scenario, phase, releasedAtEpochMs: Date.now(),
      target: { guildId: "1533228590643155034", voiceChannelId: "1533228823045214398", mutationTarget: "test-only" },
    });
  }
  async publishSupplementalGate(
    spec: HostedCampaignExecutableSpec,
    phase: "connection" | "playback",
    bounded: HostedCampaignBoundedSignal,
  ): Promise<void> {
    assertActive(bounded);
    assertPinnedTarget(spec);
    const gate = spec.supplementalGates?.[phase];
    const campaignId = spec.environment.DISCORD_E2E_SUPPLEMENTAL_CAMPAIGN_ID;
    const runId = spec.environment.DISCORD_E2E_SUPPLEMENTAL_RUN_ID;
    if (gate === undefined || campaignId === undefined || runId === undefined) {
      throw new Error(`Hosted supplemental player ${spec.childId} has an incomplete ${phase} gate`);
    }
    await writeSupplementalPlaybackGate({
      campaignId, guildId: HOSTED_CAMPAIGN_TARGET.guildId, path: gate.path, phase,
      releasedAtEpochMs: Date.now(), runId, schemaVersion: 1,
      voiceChannelId: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
    });
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
    const exit = await raceWithBounded(state.exited, bounded);
    await raceWithBounded(this.#terminateChildTree(state), bounded);
    await raceWithBounded(state.closed, bounded);
    await raceWithBounded(state.eventIngestion, bounded);
    this.#children.delete(handle.childId);
    if (state.failure !== undefined) {throw state.failure;}
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`Hosted campaign child ${handle.childId} failed (${String(exit.code ?? exit.signal)})`);
    }
    const completion = spec.completion;
    if (completion.kind === "service-level-sources") {
      await publishServiceLevelSourceCompletion(state.stdoutChunks, completion, this.#options.artifactStore);
      return;
    }
    if (isFiniteCompletion(completion)) {
      await publishFiniteCompletion(state.stdoutChunks, completion, this.#options.artifactStore);
      return;
    }
    const output = parseJsonOutput(state.stdoutChunks, handle.childId);
    if (completion.kind === "provenance-probe") {
      const parsed = hostedCampaignProvenanceCompletionV1Schema.parse(output);
      if (parsed.campaignId !== completion.campaignId || parsed.phase !== completion.phase
        || JSON.stringify(parsed.runIds) !== JSON.stringify(completion.runIds)
        || JSON.stringify(parsed.target) !== JSON.stringify(HOSTED_CAMPAIGN_TARGET)) {
        throw new Error(`Hosted campaign provenance ${handle.childId} output correlation mismatch`);
      }
      await this.#options.artifactStore.publishAction(completion.action, {
        digestSha256: parsed.digestSha256,
      });
      return;
    }
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
    if (completion.kind === "service-levels") {
      const identity = await verifyHostedServiceLevelCompletion(output, completion);
      await this.#options.artifactStore.publishAction(completion.action, {
        measurementCount: 3, outputPath: completion.outputPath,
        recordingId: identity.recordingId, runId: completion.runId,
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
    const environment = {
      ...(SSH_RUNTIME_ENTRYPOINTS.has(spec.entrypoint) ? this.#trustedRuntimeEnvironment : {}),
      ...validateEnvironment(spec.environment),
    };
    const child = spawn(process.execPath, [join(this.#options.distRoot, ENTRYPOINTS[spec.entrypoint]), ...argumentsFor(spec)], {
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
    signalChildTree(state.child, "SIGTERM");
    if (!await waitForChildTreeExit(state.child, grace)) {
      signalChildTree(state.child, "SIGKILL");
      if (!await waitForChildTreeExit(state.child, grace)) {
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

function recordingIdentityCoordinates(value: unknown): { readonly meetingId: string; readonly recordingId: string } {
  const { meetingId, recordingId } = recordingReadyReceiptV1Schema.parse(value);
  return { meetingId, recordingId };
}

async function publishServiceLevelSourceCompletion(
  chunks: readonly Buffer[],
  completion: Extract<NonNullable<HostedCampaignExecutableSpec["completion"]>, { readonly kind: "service-level-sources" }>,
  artifactStore: HostedCampaignArtifactStore,
): Promise<void> {
  const stdout = Buffer.concat(chunks).toString("utf8");
  await verifyServiceLevelSourceCompletion(stdout, completion);
  await artifactStore.publishAction(completion.action, {
    outputPath: completion.reportPath, runId: completion.runId, sourcesReady: true,
  });
}

async function publishFiniteCompletion(
  chunks: readonly Buffer[], completion: HostedFiniteProcessCompletion,
  artifactStore: HostedCampaignArtifactStore,
): Promise<void> {
  const stdout = Buffer.concat(chunks).toString("utf8");
  const verifiedArtifact = await verifyHostedFiniteProcessCompletion(stdout, completion);
  const coordinates = completion.kind === "recording-ready"
    ? recordingIdentityCoordinates(verifiedArtifact) : {};
  await artifactStore.publishAction(completion.action, {
    completed: true, ordinal: completion.action.ordinal, runId: completion.action.runId, ...coordinates,
  });
}

async function verifyServiceLevelSourceCompletion(
  stdout: string,
  expected: Extract<NonNullable<HostedCampaignExecutableSpec["completion"]>, { readonly kind: "service-level-sources" }>,
): Promise<void> {
  const line = stdout.trimEnd().split("\n").at(-1);
  if (line === undefined) {throw new Error("Hosted service-level sources produced no completion output");}
  const schema = z.object({
    campaignId: z.literal(expected.campaignId), clockAttestationsPath: z.literal(expected.clockAttestationsPath),
    databasePath: z.literal(expected.databasePath), kind: z.literal("hosted-service-level-sources-completion"),
    meetingId: z.string(), meetingPlatformLogsPath: z.literal(expected.meetingPlatformLogsPath),
    recordingId: z.string(), reportPath: z.literal(expected.reportPath), runId: z.literal(expected.runId),
    s3Path: z.literal(expected.s3Path), status: z.literal("ready"),
  }).strict();
  const parsed = schema.parse(JSON.parse(line) as unknown);
  if ((expected.meetingId !== undefined && parsed.meetingId !== expected.meetingId)
    || (expected.recordingId !== undefined && parsed.recordingId !== expected.recordingId)) {
    throw new Error("Hosted service-level source completion identity mismatch");
  }
  const report = hostedServiceLevelSourceReportV1Schema.parse(JSON.parse(
    await readPrivateHostedServiceLevelArtifact(expected.reportPath),
  ) as unknown);
  if (report.status !== "ready" || report.campaignId !== expected.campaignId
    || report.runId !== expected.runId || report.meetingId !== parsed.meetingId
    || report.recordingId !== parsed.recordingId || report.reportPath !== expected.reportPath
    || report.outputs.database !== expected.databasePath || report.outputs.s3 !== expected.s3Path
    || report.outputs.meetingPlatformLogs !== expected.meetingPlatformLogsPath
    || report.outputs.clockAttestations !== expected.clockAttestationsPath) {
    throw new Error("Hosted service-level source report is not ready for this run");
  }
  await Promise.all([
    expected.databasePath, expected.s3Path, expected.meetingPlatformLogsPath, expected.clockAttestationsPath,
  ].map(readPrivateHostedServiceLevelArtifact));
}

function isFiniteCompletion(
  completion: HostedCampaignExecutableSpec["completion"] & object,
): completion is HostedFiniteProcessCompletion {
  return new Set(["actor", "conversation-observer", "playback-link-observer", "recording-ready",
    "replay-attestation-publisher", "supplemental-player"]).has((completion as { readonly kind: string }).kind);
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
    const timer = setTimeout(() => { reject(new Error("Hosted campaign deadline expired")); }, remaining);
    const abort = (): void => { reject(bounded.signal.reason ?? new Error("Hosted campaign cancelled")); };
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
    if (TRUSTED_RUNTIME_ENVIRONMENT_NAMES.has(name) || name === "NODE_OPTIONS" || name.startsWith("LD_")
      || name.startsWith("DYLD_") || name.includes("TOKEN") || !ALLOWED_ENVIRONMENT.has(name)) {
      throw new Error(`Hosted campaign child environment variable is forbidden: ${name}`);
    }
    clean[name] = value;
  }
  return clean;
}

export function validateHostedCampaignTrustedRuntimeEnvironment(
  input: unknown,
): HostedCampaignTrustedRuntimeEnvironment {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Hosted campaign trusted runtime environment must be configured");
  }
  const environment = input as Readonly<Record<string, unknown>>;
  for (const name of Object.keys(environment)) {
    if (!TRUSTED_RUNTIME_ENVIRONMENT_NAMES.has(name)) {
      throw new Error(`Hosted campaign trusted runtime environment variable is forbidden: ${name}`);
    }
  }
  const home = validateTrustedAbsolutePath("HOME", environment.HOME);
  const path = validateTrustedValue("PATH", environment.PATH, 16 * 1024);
  if (!path.split(delimiter).every((entry) => entry.length > 0 && isAbsolute(entry))) {
    throw new Error("Hosted campaign trusted runtime environment PATH must contain only absolute entries");
  }
  const optional = <Name extends "LANG" | "LC_ALL" | "SSH_AUTH_SOCK">(
    name: Name,
  ): { readonly [Key in Name]: string } | Record<never, never> => {
    const value = environment[name];
    if (value === undefined) {
      return {};
    }
    return {
      [name]: name === "SSH_AUTH_SOCK"
        ? validateTrustedAbsolutePath(name, value)
        : validateTrustedValue(name, value, 128),
    } as { readonly [Key in Name]: string };
  };
  return Object.freeze({
    HOME: home,
    ...optional("LANG"),
    ...optional("LC_ALL"),
    PATH: path,
    ...optional("SSH_AUTH_SOCK"),
  });
}

function validateTrustedAbsolutePath(name: "HOME" | "SSH_AUTH_SOCK", value: unknown): string {
  const validated = validateTrustedValue(name, value, 4 * 1024);
  if (!isAbsolute(validated)) {
    throw new Error(`Hosted campaign trusted runtime environment ${name} must be absolute`);
  }
  return validated;
}

function validateTrustedValue(name: string, value: unknown, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength
    || containsControlCharacter(value)) {
    throw new Error(`Hosted campaign trusted runtime environment ${name} is unsafe`);
  }
  return value;
}
function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
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
function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || !isChildTreeAlive(child)) {return;}
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {throw error;}
  }
}

async function waitForChildTreeExit(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (!isChildTreeAlive(child)) {return true;}
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    await new Promise((resolve) => {setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now())));});
    if (!isChildTreeAlive(child)) {return true;}
  }
  return !isChildTreeAlive(child);
}

function isChildTreeAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) {return false;}
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
    return process.platform === "win32" || processGroupHasExecutableMember(child.pid);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || (code === "EPERM" && process.platform === "darwin")) {return false;}
    throw error;
  }
}

function processGroupHasExecutableMember(processGroupId: number): boolean {
  const result = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  if (result.status !== 0 || result.error !== undefined) {
    return true;
  }
  return result.stdout.split("\n").some((line) => {
    const match = /^\s*(\d+)\s+(\S+)/u.exec(line);
    return match?.[1] === String(processGroupId) && !match[2]?.startsWith("Z");
  });
}
