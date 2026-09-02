import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";

import { describe, it } from "vitest";

import {
  FetchVoicetextBatchClient,
  VoicetextLiveTranscriptionAdapter,
  type VoicetextBatchProfile,
  type VoicetextBatchTaskResult,
  type VoicetextLiveProfile,
  type VoicetextLiveTranscriptEvent,
} from "../src/index.js";
import { boundedFetch, readJson } from "./voicetext-gateway-black-box-support.js";
import {
  buildProviderCanaryReceipt,
  digestCanonical,
  parseGatewayRunningIdentity,
  validateProviderCanaryReceipt,
  writeCreateOnlyReceipt,
  type CanaryProvider,
  type GatewayRunningIdentityV1,
  type ProviderCanaryReceiptV1,
} from "./voicetext-provider-canary-evidence.js";
import { extractOggOpusSpeechPackets } from "./voicetext-provider-canary-ogg.js";

const PINNED_GATEWAY_COMMIT = "7adb5bb4c5c063ba3973e8bc76a759ac8ea29bb4";
const PINNED_FIXTURE_SHA256 = "8e29a933ef95eaf1f149b150ff123f90a3276847fcd4941ccb6c55b24561b9d8";
const PINNED_EXPECTED_TERMS = Object.freeze([
  "Meeting Platform", "Craig recording", "PostgreSQL", "Discord", "пятницу",
]);
const MAXIMUM_TIMESTAMP_OVERRUN_MS = 10_000;
const POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 1_000;

interface CanaryConfiguration {
  readonly expectedIdentitySha256: string;
  readonly expectedImageDigest: string;
  readonly expectedTree: string;
  readonly fixturePath: string;
  readonly httpOrigin: string;
  readonly identityFile: string;
  readonly profile: CanaryProvider;
  readonly receiptPath: string;
  readonly runId: string;
  readonly token: string;
  readonly wsOrigin: string;
}
interface IdentityFileObservation {
  readonly bytes: Uint8Array; readonly ctimeMs: number; readonly device: number;
  readonly inode: number; readonly mtimeMs: number; readonly size: number;
}
interface TranscriptSegment { readonly endMs: number; readonly startMs: number; readonly text: string }

const required = process.env.VOICETEXT_GATEWAY_PROVIDER_CANARY_REQUIRED === "1";
const loadedConfiguration = required ? loadConfiguration(process.env) : undefined;

describe("VoiceText gateway opt-in real-provider canary", () => {
  it.skipIf(!required)("sends pinned speech and retains an exact running-identity-bound receipt", async () => {
    if (loadedConfiguration === undefined) { throw new Error("Required provider canary configuration was not loaded"); }
    await runProviderCanary(loadedConfiguration);
  }, 240_000);
});

async function runProviderCanary(configuration: CanaryConfiguration): Promise<void> {
  const identityObservation = await readIdentityFile(configuration.identityFile);
  const identity = parseIdentityBytes(identityObservation.bytes, configuration);
  await assertReadyProfile(configuration);
  const fixture = await readFile(configuration.fixturePath);
  if (sha256(fixture) !== PINNED_FIXTURE_SHA256) {
    throw new Error("Provider canary fixture does not match the pinned speech fixture");
  }
  const extracted = extractOggOpusSpeechPackets(fixture);
  const profiles = profilesFor(configuration.profile);
  const signal = AbortSignal.timeout(220_000);
  const idempotencyKey = sha256(Buffer.from(JSON.stringify({
    expectedTerms: PINNED_EXPECTED_TERMS,
    fixtureSha256: PINNED_FIXTURE_SHA256,
    gatewayIdentitySha256: identity.identitySha256,
    profile: configuration.profile,
    runId: configuration.runId,
  })));

  const completed = await runBatch(configuration, fixture, profiles.batch, idempotencyKey, signal);
  const batchSegments = completed.result.utterances.map((utterance) => ({
    endMs: Math.round(utterance.endSeconds * 1_000),
    startMs: Math.round(utterance.startSeconds * 1_000),
    text: utterance.transcript,
  }));
  const liveSegments = await runLive(configuration, extracted.packets, profiles.live, idempotencyKey, signal);
  assertProviderTranscript("batch", batchSegments, PINNED_EXPECTED_TERMS, extracted.durationMs);
  assertProviderTranscript("live", liveSegments, PINNED_EXPECTED_TERMS, extracted.durationMs);

  const identityAfter = await readIdentityFile(configuration.identityFile);
  if (!sameIdentityFile(identityObservation, identityAfter)) {
    throw new Error("Running gateway identity evidence changed during the provider canary");
  }
  parseIdentityBytes(identityAfter.bytes, configuration);
  const receipt = buildReceipt({
    batchJobId: completed.jobId, batchSegments, configuration,
    durationMs: extracted.durationMs, identity, liveSegments,
    packetCount: extracted.packets.length, profiles,
  });
  validateProviderCanaryReceipt(receipt, {
    expectedTermsSha256: digestCanonical(PINNED_EXPECTED_TERMS),
    fixtureSha256: PINNED_FIXTURE_SHA256,
    gatewayIdentitySha256: identity.identitySha256,
    profile: configuration.profile,
    runId: configuration.runId,
  });
  await writeCreateOnlyReceipt(configuration.receiptPath, receipt);
}

async function assertReadyProfile(configuration: CanaryConfiguration): Promise<void> {
  const response = await boundedFetch(new URL("/health", configuration.httpOrigin));
  if (response.status !== 200) { throw new Error("Provider canary gateway health request failed"); }
  const health = await readJson(response);
  const values = Array.isArray(health.provider_profiles) ? health.provider_profiles : [];
  const profiles = profilesFor(configuration.profile);
  if (!values.some((value) => matchesReadyProfile(value, "batch", profiles.batch))
    || !values.some((value) => matchesReadyProfile(value, "live", profiles.live))) {
    throw new Error("Provider canary gateway does not report the selected profiles ready");
  }
}

function matchesReadyProfile(value: unknown, mode: string, profile: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).mode === mode
    && (value as Record<string, unknown>).profile === profile
    && (value as Record<string, unknown>).ready === true;
}

async function runBatch(
  configuration: CanaryConfiguration, fixture: Uint8Array, profile: VoicetextBatchProfile,
  idempotencyKey: string, signal: AbortSignal,
): Promise<Extract<VoicetextBatchTaskResult, { readonly kind: "completed" }>> {
  const client = new FetchVoicetextBatchClient({
    endpoint: new URL("/api/v1/transcribe/batch", configuration.httpOrigin).toString(),
    profile, token: configuration.token,
  });
  const request = { audio: fixture, idempotencyKey, keyterms: PINNED_EXPECTED_TERMS, signal };
  const first = await completeBatch(client, await client.submit(request), signal);
  const replay = await completeBatch(client, await client.submit(request), signal);
  if (digestCanonical(first) !== digestCanonical(replay)) {
    throw new Error("Provider canary batch idempotent replay changed its result");
  }
  return first;
}

async function completeBatch(
  client: FetchVoicetextBatchClient, initial: VoicetextBatchTaskResult, signal: AbortSignal,
): Promise<Extract<VoicetextBatchTaskResult, { readonly kind: "completed" }>> {
  let result = initial;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (result.kind === "completed") { return result; }
    if (result.kind === "failed") { throw new Error(`Provider canary batch failed with ${result.errorCode}`); }
    await delay(Math.min(result.retryAfterMs, POLL_INTERVAL_MS), signal);
    result = await client.poll({ jobId: result.jobId, signal });
  }
  throw new Error("Provider canary batch did not complete within its bounded poll window");
}

async function runLive(
  configuration: CanaryConfiguration,
  packets: ReturnType<typeof extractOggOpusSpeechPackets>["packets"],
  profile: VoicetextLiveProfile, idempotencyKey: string, signal: AbortSignal,
): Promise<readonly TranscriptSegment[]> {
  const events: VoicetextLiveTranscriptEvent[] = [];
  const adapter = new VoicetextLiveTranscriptionAdapter({
    audioAckTimeoutMs: 10_000,
    endpoint: new URL("/api/v1/transcribe/stream", configuration.wsOrigin).toString(),
    finalizeTimeoutMs: 45_000, keyterms: PINNED_EXPECTED_TERMS,
    language: "multi", profile, token: configuration.token,
  });
  const session = await adapter.openSession({
    idempotencyKey, meetingId: `provider-canary:${configuration.runId}`,
    onTranscript: (event) => events.push(event), signal, speakerId: "pinned-speech-fixture",
  });
  try {
    for (const [index, packet] of packets.entries()) {
      const status = await session.sendPacket({
        durationSamples48Khz: packet.durationSamples48Khz, opus: packet.opus,
        packetId: `${PINNED_FIXTURE_SHA256}:${String(index)}`,
        relativeTimeMs: packet.relativeTimeMs,
      });
      if (status !== "accepted") { throw new Error("Provider canary unexpectedly reused a speech packet"); }
      await delay(packet.durationSamples48Khz / 48, signal);
    }
    await session.finalize();
  } catch (error) {
    session.terminate();
    throw error;
  }
  return events.filter(({ isFinal }) => isFinal).map(({ endMs, startMs, text }) => ({ endMs, startMs, text }));
}

function assertProviderTranscript(
  mode: string, segments: readonly TranscriptSegment[],
  expectedTerms: readonly string[], fixtureDurationMs: number,
): void {
  if (segments.length === 0) { throw new Error(`Provider canary ${mode} returned no final text`); }
  let previousStart = -1;
  for (const segment of segments) {
    if (!Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs)
      || segment.startMs < 0 || segment.endMs <= segment.startMs || segment.startMs < previousStart
      || segment.endMs > fixtureDurationMs + MAXIMUM_TIMESTAMP_OVERRUN_MS || segment.text.trim().length === 0) {
      throw new Error(`Provider canary ${mode} returned invalid transcript timestamps or text`);
    }
    previousStart = segment.startMs;
  }
  const normalized = normalize(segments.map(({ text }) => text).join(" "));
  if (normalized.includes("synthetic live speech") || normalized.includes("synthetic speech")) {
    throw new Error(`Provider canary ${mode} returned the providerless fixture text`);
  }
  for (const term of expectedTerms) {
    if (!normalized.includes(normalize(term))) {
      throw new Error(`Provider canary ${mode} omitted a required pinned-fixture term`);
    }
  }
}

function buildReceipt(input: Readonly<{
  batchJobId: string; batchSegments: readonly TranscriptSegment[];
  configuration: CanaryConfiguration; durationMs: number;
  identity: GatewayRunningIdentityV1; liveSegments: readonly TranscriptSegment[];
  packetCount: number; profiles: ReturnType<typeof profilesFor>;
}>): ProviderCanaryReceiptV1 {
  return buildProviderCanaryReceipt({
    batch: { ...transcriptEvidence(input.batchSegments), jobId: input.batchJobId },
    createdAt: new Date().toISOString(),
    expectedTermsSha256: digestCanonical(PINNED_EXPECTED_TERMS),
    fixture: { durationMs: input.durationMs, packetCount: input.packetCount, sha256: PINNED_FIXTURE_SHA256 },
    gatewayIdentity: input.identity,
    gatewayIdentitySha256: input.identity.identitySha256,
    kind: "voicetext-gateway-provider-canary-receipt",
    live: { ...transcriptEvidence(input.liveSegments), acknowledgedPacketCount: input.packetCount, finalizeComplete: true },
    profile: { ...input.profiles, provider: input.configuration.profile },
    runId: input.configuration.runId,
    schemaVersion: 1,
  });
}

async function readIdentityFile(path: string): Promise<IdentityFileObservation> {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) { throw new Error("Gateway identity custody is unsupported"); }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== currentUid || (before.mode & 0o777) !== 0o400
      || before.size < 1 || before.size > 65_536) {
      throw new Error("Gateway identity file custody is invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || bytes.byteLength !== before.size) {
      throw new Error("Gateway identity file changed while being read");
    }
    return { bytes, ctimeMs: before.ctimeMs, device: before.dev, inode: before.ino,
      mtimeMs: before.mtimeMs, size: before.size };
  } finally { await handle.close(); }
}

function sameIdentityFile(left: IdentityFileObservation, right: IdentityFileObservation): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && Buffer.from(left.bytes).equals(right.bytes);
}

function transcriptEvidence(segments: readonly TranscriptSegment[]) {
  return {
    firstStartMs: segments[0]?.startMs ?? 0,
    lastEndMs: segments.at(-1)?.endMs ?? 0,
    segmentCount: segments.length,
    textSha256: digestCanonical(segments),
  };
}

function parseIdentityBytes(bytes: Uint8Array, configuration: CanaryConfiguration): GatewayRunningIdentityV1 {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown; }
  catch (error) { throw new Error("Gateway running identity file is not JSON", { cause: error }); }
  return parseGatewayRunningIdentity(value, {
    httpOrigin: configuration.httpOrigin, identitySha256: configuration.expectedIdentitySha256,
    imageDigest: configuration.expectedImageDigest, runId: configuration.runId,
    sourceCommit: PINNED_GATEWAY_COMMIT, sourceTree: configuration.expectedTree,
    wsOrigin: configuration.wsOrigin,
  });
}

function profilesFor(provider: CanaryProvider): Readonly<{
  batch: VoicetextBatchProfile; live: VoicetextLiveProfile;
}> {
  return provider === "deepgram"
    ? { batch: "deepgram-nova-3", live: "deepgram-nova-3" }
    : { batch: "elevenlabs-scribe-v2", live: "elevenlabs-scribe-v2-realtime" };
}

function loadConfiguration(environment: NodeJS.ProcessEnv): CanaryConfiguration {
  const variable = (name: string): string => {
    const value = environment[name];
    if (value === undefined || value.length === 0) { throw new Error(`Required provider canary variable is missing: ${name}`); }
    return value;
  };
  const httpOrigin = exactOrigin(variable("VOICETEXT_GATEWAY_PROVIDER_CANARY_HTTP_ORIGIN"), ["http:", "https:"]);
  const wsOrigin = exactOrigin(variable("VOICETEXT_GATEWAY_PROVIDER_CANARY_WS_ORIGIN"), ["ws:", "wss:"]);
  const profile = variable("VOICETEXT_GATEWAY_PROVIDER_CANARY_PROFILE");
  const expectedTree = variable("VOICETEXT_GATEWAY_PROVIDER_CANARY_EXPECTED_TREE");
  const expectedImageDigest = variable("VOICETEXT_GATEWAY_PROVIDER_CANARY_EXPECTED_IMAGE_DIGEST");
  const expectedIdentitySha256 = variable("VOICETEXT_GATEWAY_PROVIDER_CANARY_EXPECTED_IDENTITY_SHA256");
  const runId = variable("VOICETEXT_GATEWAY_PROVIDER_CANARY_RUN_ID");
  const token = variable("VOICETEXT_GATEWAY_PROVIDER_CANARY_TOKEN");
  if ((profile !== "deepgram" && profile !== "elevenlabs")
    || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/u.test(expectedTree)
    || !/^[^\s@]+@sha256:[a-f\d]{64}$/u.test(expectedImageDigest)
    || !/^[a-f\d]{64}$/u.test(expectedIdentitySha256)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(runId)
    || token.length < 16 || token.length > 8_192 || /\s/u.test(token)) {
    throw new Error("Provider canary configuration is invalid");
  }
  return {
    expectedIdentitySha256, expectedImageDigest,
    expectedTree,
    fixturePath: absolutePath(variable("VOICETEXT_GATEWAY_PROVIDER_CANARY_FIXTURE")),
    httpOrigin,
    identityFile: absolutePath(variable("VOICETEXT_GATEWAY_PROVIDER_CANARY_IDENTITY_FILE")),
    profile,
    receiptPath: absolutePath(variable("VOICETEXT_GATEWAY_PROVIDER_CANARY_RECEIPT")),
    runId, token, wsOrigin,
  };
}

function exactOrigin(raw: string, protocols: readonly string[]): string {
  const origin = new URL(raw);
  if (!protocols.includes(origin.protocol) || origin.origin !== raw || origin.username !== "" || origin.password !== "") {
    throw new Error("Provider canary origin is invalid");
  }
  return raw;
}
function absolutePath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) { throw new Error("Provider canary paths must be absolute"); }
  return path;
}
function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replaceAll(/\s+/gu, " ").trim();
}
function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const complete = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(complete, milliseconds);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
