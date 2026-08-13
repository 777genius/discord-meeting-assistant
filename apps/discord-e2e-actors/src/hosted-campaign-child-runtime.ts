import { delimiter, isAbsolute } from "node:path";

import type {
  HostedCampaignEntrypoint,
  HostedCampaignExecutableSpec,
} from "./hosted-campaign-coordinator.js";

const ENTRYPOINTS: Readonly<Record<HostedCampaignEntrypoint, string>> = Object.freeze({
  actor: "main.js", "campaign-verifier": "verify-campaign.js",
  collector: "collect-retained-evidence.js", "conversation-observer": "observe-conversation-voice.js",
  "evidence-verifier": "verify-retained-evidence.js", "live-observer": "observe-live-discord.js",
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
  "DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT", "DISCORD_E2E_CONVERSATION_VOICE_GREETING_HANDSHAKE_ROOT",
  "DISCORD_E2E_CONVERSATION_VOICE_PRIVATE_TEST_GUILD", "DISCORD_E2E_CONVERSATION_VOICE_PURPOSE",
  "DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS", "DISCORD_E2E_CONVERSATION_VOICE_RECORDING_ID",
  "DISCORD_E2E_CONVERSATION_VOICE_RUN_ID", "DISCORD_E2E_CONVERSATION_VOICE_SECRET_DIRECTORY",
  "DISCORD_E2E_CONVERSATION_VOICE_TURN_ID", "DISCORD_E2E_CONVERSATION_VOICE_VOICE_CHANNEL_ID",
  "DISCORD_E2E_EVIDENCE_OUTPUT", "DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION",
  "DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION", "DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION",
  "DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION", "DISCORD_E2E_FIXTURE_MANIFEST",
  "DISCORD_E2E_GUILD_ID", "DISCORD_E2E_KEYCHAIN_SERVICE", "DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID",
  "DISCORD_E2E_HOSTED_RELEASE_GATE_PATH", "DISCORD_E2E_HOSTED_RELEASE_GATE_ARMED_PATH",
  "DISCORD_E2E_HOSTED_PLAYBACK_GATE_PATH", "DISCORD_E2E_HOSTED_PLAYBACK_GATE_ARMED_PATH",
  "DISCORD_E2E_HOSTED_END_GATE_PATH", "DISCORD_E2E_HOSTED_END_GATE_ARMED_PATH",
  "DISCORD_E2E_HOSTED_SPEAKER_B_GATE_PATH", "DISCORD_E2E_HOSTED_SPEAKER_B_GATE_ARMED_PATH",
  "DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS", "DISCORD_E2E_HOSTED_CAMPAIGN_ID",
  "DISCORD_E2E_LIVE_DURATION_MS", "DISCORD_E2E_LIVE_KEYCHAIN_SERVICE", "DISCORD_E2E_LIVE_OUTPUT",
  "DISCORD_E2E_LIVE_POLL_INTERVAL_MS", "DISCORD_E2E_LIVE_RESULT_CHANNEL_ID", "DISCORD_E2E_LIVE_RUN_ID",
  "DISCORD_E2E_LIVE_SECRET_DIRECTORY", "DISCORD_E2E_LIVE_SUT_ACCOUNT", "DISCORD_E2E_LIVE_SUT_APPLICATION_ID",
  "DISCORD_E2E_MUTATION_TARGET", "DISCORD_E2E_PLAYBACK_TIMEOUT_MS", "DISCORD_E2E_POST_PLAYBACK_HOLD_MS",
  "DISCORD_E2E_PLAYBACK_LINK_DURATION_MS", "DISCORD_E2E_PLAYBACK_LINK_KEYCHAIN_SERVICE",
  "DISCORD_E2E_PLAYBACK_LINK_MODE", "DISCORD_E2E_PLAYBACK_LINK_OUTPUT",
  "DISCORD_E2E_PLAYBACK_LINK_POLL_INTERVAL_MS", "DISCORD_E2E_PLAYBACK_LINK_PROJECTION_CONTAINER_JSON",
  "DISCORD_E2E_PLAYBACK_LINK_PROJECTION_MARKER", "DISCORD_E2E_PLAYBACK_LINK_MEETING_ID",
  "DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID", "DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID",
  "DISCORD_E2E_PLAYBACK_LINK_RECORDING_PLAYBACK_ORIGIN",
  "DISCORD_E2E_PLAYBACK_LINK_READY_RECEIPT_INPUT",
  "DISCORD_E2E_PLAYBACK_LINK_RUN_ID", "DISCORD_E2E_PLAYBACK_LINK_SECRET_DIRECTORY",
  "DISCORD_E2E_PLAYBACK_LINK_SUT_ACCOUNT", "DISCORD_E2E_PLAYBACK_LINK_SUT_APPLICATION_ID",
  "DISCORD_E2E_PRE_PLAYBACK_HOLD_MS", "DISCORD_E2E_READY_TIMEOUT_MS", "DISCORD_E2E_RECORDER_BOT_ID",
  "DISCORD_E2E_PROVENANCE_CAMPAIGN_ID", "DISCORD_E2E_PROVENANCE_PHASE", "DISCORD_E2E_PROVENANCE_RUN_IDS_JSON",
  "DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH", "DISCORD_E2E_REPLAY_FIXTURE_MANIFEST",
  "DISCORD_E2E_REPLAY_MUTATION_TARGET", "DISCORD_E2E_REPLAY_RECORDING_ID",
  "DISCORD_E2E_REPLAY_REMOTE_ATTESTATION_FILE", "DISCORD_E2E_REPLAY_REMOTE_COMPOSE_FILE",
  "DISCORD_E2E_REPLAY_REMOTE_ENV_FILE", "DISCORD_E2E_REPLAY_REMOTE_HOST",
  "DISCORD_E2E_REPLAY_REMOTE_SOURCE_ROOT", "DISCORD_E2E_REPLAY_RUN_ID", "DISCORD_E2E_READY_RECEIPT_INPUT",
  "DISCORD_E2E_READY_RECEIPT_OUTPUT", "DISCORD_E2E_READY_RECEIPT_POLL_INTERVAL_MS",
  "DISCORD_E2E_READY_RECEIPT_TIMEOUT_MS", "DISCORD_E2E_RECORDING_ID", "DISCORD_E2E_RECORDING_PLAYBACK_ORIGIN",
  "DISCORD_E2E_RECORDING_PLAYBACK_READINESS", "DISCORD_E2E_RECORDING_PLAYBACK_TEST_SCOPE",
  "DISCORD_E2E_REMOTE_ATTESTATION_FILE", "DISCORD_E2E_REMOTE_COMPOSE_FILE", "DISCORD_E2E_REMOTE_CRAIG_PROJECT",
  "DISCORD_E2E_REMOTE_CRAIG_SERVICE", "DISCORD_E2E_REMOTE_ENV_FILE", "DISCORD_E2E_REMOTE_HOST",
  "DISCORD_E2E_REMOTE_PROJECT", "DISCORD_E2E_REMOTE_SOURCE_ROOT", "DISCORD_E2E_RUN_ID", "DISCORD_E2E_SCENARIO",
  "DISCORD_E2E_SECRET_DIRECTORY", "DISCORD_E2E_SERVICE_LEVELS_INPUT", "DISCORD_E2E_SLA_CAMPAIGN_ID",
  "DISCORD_E2E_SLA_CAMPAIGN_PROOF_INPUT", "DISCORD_E2E_SLA_CLOCK_ATTESTATIONS_INPUT",
  "DISCORD_E2E_SLA_CLOCK_PREFLIGHT_INPUT", "DISCORD_E2E_SLA_DATABASE_INPUT",
  "DISCORD_E2E_SLA_FIXTURE_MANIFEST_INPUT", "DISCORD_E2E_SLA_MEETING_ID",
  "DISCORD_E2E_SLA_MEETING_PLATFORM_LOG_INPUT", "DISCORD_E2E_SLA_OUTPUT",
  "DISCORD_E2E_SLA_PLAYBACK_LINK_PROOF_INPUT", "DISCORD_E2E_SLA_READY_RECEIPT_INPUT",
  "DISCORD_E2E_SLA_RECORDING_ID", "DISCORD_E2E_SLA_REPORT_OUTPUT", "DISCORD_E2E_SLA_RUN_ID",
  "DISCORD_E2E_SLA_SOURCE_REPORT_OUTPUT", "DISCORD_E2E_SLA_S3_INPUT",
  "DISCORD_E2E_SLA_SUPPLEMENTAL_PLAYBACK_INPUT", "DISCORD_E2E_SLA_VOICE_INPUTS",
  "DISCORD_E2E_SERVICE_LEVEL_THRESHOLDS_INPUT", "DISCORD_E2E_SPEAKER_A_ACCOUNT",
  "DISCORD_E2E_SPEAKER_A_FIXTURE", "DISCORD_E2E_SPEAKER_B_ACCOUNT", "DISCORD_E2E_SPEAKER_B_CONNECT_DELAY_MS",
  "DISCORD_E2E_SPEAKER_B_DELAY_MS", "DISCORD_E2E_SPEAKER_B_FIXTURE", "DISCORD_E2E_SUPPLEMENTAL_EVIDENCE_OUTPUT",
  "DISCORD_E2E_SUPPLEMENTAL_KEYCHAIN_ACCOUNT", "DISCORD_E2E_SUPPLEMENTAL_CAMPAIGN_ID",
  "DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_PATH", "DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_ARMED_PATH",
  "DISCORD_E2E_SUPPLEMENTAL_GATE_TIMEOUT_MS", "DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_PATH",
  "DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_ARMED_PATH", "DISCORD_E2E_SUPPLEMENTAL_KEYCHAIN_SERVICE",
  "DISCORD_E2E_SUPPLEMENTAL_MANIFEST", "DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT",
  "DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_TIMEOUT_MS", "DISCORD_E2E_SUPPLEMENTAL_POST_HOLD_MS",
  "DISCORD_E2E_SUPPLEMENTAL_PRE_HOLD_MS", "DISCORD_E2E_SUPPLEMENTAL_PRIVATE_TEST_GUILD",
  "DISCORD_E2E_SUPPLEMENTAL_READY_TIMEOUT_MS", "DISCORD_E2E_SUPPLEMENTAL_RUN_ID",
  "DISCORD_E2E_SUPPLEMENTAL_SECRET_DIRECTORY", "DISCORD_E2E_SUT_ACCOUNT", "DISCORD_E2E_VOICE_CHANNEL_ID",
]);

const TRUSTED_RUNTIME_ENVIRONMENT_NAMES = new Set(["HOME", "LANG", "LC_ALL", "PATH", "SSH_AUTH_SOCK"]);
export const SSH_RUNTIME_ENTRYPOINTS: ReadonlySet<HostedCampaignEntrypoint> = new Set([
  "collector", "provenance-probe", "recording-ready", "replay-attestation-publisher", "service-level-sources",
]);

export interface HostedCampaignTrustedRuntimeEnvironment {
  readonly HOME: string; readonly LANG?: string; readonly LC_ALL?: string;
  readonly PATH: string; readonly SSH_AUTH_SOCK?: string;
}

export function entrypointFile(entrypoint: HostedCampaignEntrypoint): string {return ENTRYPOINTS[entrypoint];}

export function argumentsFor(spec: HostedCampaignExecutableSpec): readonly string[] {
  const args = spec.arguments;
  if (args.kind === "environment") {return [];}
  if (args.kind === "evidence-verifier") {
    return [args.manifestPath, args.evidencePath, ...(args.thresholdsPath === undefined ? [] : [args.thresholdsPath])];
  }
  return [args.manifestPath, ...args.evidencePaths,
    ...(args.thresholdsPath === undefined ? [] : ["--service-level-thresholds", args.thresholdsPath])];
}

export function validateChildEnvironment(environment: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
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
  const optional = <Name extends "LANG" | "LC_ALL" | "SSH_AUTH_SOCK">(name: Name):
  { readonly [Key in Name]: string } | Record<never, never> => {
    const value = environment[name];
    if (value === undefined) {return {};}
    return {[name]: name === "SSH_AUTH_SOCK" ? validateAbsolutePath(name, value)
      : validateValue(name, value, 128)};
  };
  const path = validateValue("PATH", environment.PATH, 16 * 1024);
  if (!path.split(delimiter).every((entry) => entry.length > 0 && isAbsolute(entry))) {
    throw new Error("Hosted campaign trusted runtime environment PATH must contain only absolute entries");
  }
  return Object.freeze({HOME: validateAbsolutePath("HOME", environment.HOME), ...optional("LANG"),
    ...optional("LC_ALL"), PATH: path, ...optional("SSH_AUTH_SOCK")});
}

function validateAbsolutePath(name: "HOME" | "SSH_AUTH_SOCK", value: unknown): string {
  const validated = validateValue(name, value, 4 * 1024);
  if (!isAbsolute(validated)) {
    throw new Error(`Hosted campaign trusted runtime environment ${name} must be absolute`);
  }
  return validated;
}
function validateValue(name: string, value: unknown, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength
    || Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0); return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })) {throw new Error(`Hosted campaign trusted runtime environment ${name} is unsafe`);}
  return value;
}
