import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  FetchVoicetextBatchClient,
  VoicetextLiveTranscriptionAdapter,
  batchEndpointFromWebSocketUrl,
  type VoicetextBatchClient,
  type VoicetextLiveSession,
} from "@discord-meeting/voicetext-adapter";
import {
  opusPacketDurationSamples,
  validateOggOpus,
} from "@discord-meeting/recording-ingress-adapter";

import {
  createVoicetextCanaryDeadline,
  waitForVoicetextCanaryOperation,
} from "./composition/voicetext-canary-deadline.js";
import { completeVoicetextCanaryBatch } from "./composition/voicetext-canary-batch.js";
import {
  voicetextCanaryBatchIdentity,
  voicetextCanaryBatchSegments,
  type VoicetextCanaryBatchIdentity,
  type VoicetextCanarySegment,
} from "./composition/voicetext-canary-result.js";

const maximumFixtureBytes = 64 * 1_024 * 1_024;
const tokenFileMaximumBytes = 4_096;

type CanarySegment = VoicetextCanarySegment;

export interface VoicetextSemanticCanaryResultV1 {
  readonly batch: {
    readonly firstSubmission: BatchIdentity;
    readonly idempotentReplay: BatchIdentity;
    readonly segments: readonly CanarySegment[];
    readonly utteranceCount: number;
  };
  readonly live: {
    readonly audioAcknowledgements: { readonly expected: number; readonly received: number };
    readonly finalizeComplete: true;
    readonly protocolReady: true;
    readonly segments: readonly CanarySegment[];
  };
  readonly schemaVersion: 1;
  readonly tokenFile: {
    readonly generationId: string;
    readonly mode: 0o400;
    readonly ownerUid: number;
    readonly path: string;
  };
}

type BatchIdentity = VoicetextCanaryBatchIdentity;

export interface VoicetextSemanticCanaryArguments {
  readonly batchEndpoint: string;
  readonly campaignId: string;
  readonly deadlineMs: number;
  readonly fixturePath: string;
  readonly fixtureSha256: string;
  readonly imageDigestSha256: string;
  readonly liveEndpoint: string;
  readonly planSha256: string;
  readonly sourceRevision: string;
}

export interface VoicetextSemanticCanaryDependencies {
  readonly createBatchClient: (input: Readonly<{ endpoint: string; token: string }>) => VoicetextBatchClient;
  readonly openLiveSession: (input: Readonly<{
    endpoint: string;
    idempotencyKey: string;
    onTranscript: (segment: CanarySegment, isFinal: boolean) => void;
    signal: AbortSignal;
    token: string;
  }>) => Promise<VoicetextLiveSession>;
  readonly readFixture: (path: string) => Promise<Uint8Array>;
  readonly readToken: (path: string) => Promise<Readonly<{
    generationId: string;
    mode: 0o400;
    ownerUid: number;
    path: string;
    token: string;
  }>>;
  readonly wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export async function runVoicetextSemanticCanary(
  args: VoicetextSemanticCanaryArguments,
  tokenFilePath: string,
  dependencies: VoicetextSemanticCanaryDependencies,
  signal: AbortSignal = new AbortController().signal,
): Promise<VoicetextSemanticCanaryResultV1> {
  validateArguments(args);
  const deadline = createVoicetextCanaryDeadline(signal, args.deadlineMs);
  try {
    deadline.signal.throwIfAborted();
    const [fixture, tokenFile] = await waitForVoicetextCanaryOperation(Promise.all([
      dependencies.readFixture(args.fixturePath),
      dependencies.readToken(tokenFilePath),
    ]), deadline.signal);
  if (fixture.byteLength > maximumFixtureBytes || sha256(fixture) !== args.fixtureSha256) {
    throw new Error("Voicetext canary fixture does not match its pinned digest");
  }
  const packets = extractOpusPackets(fixture);
  const idempotencyKey = sha256(JSON.stringify({
    campaignId: args.campaignId,
    fixtureSha256: args.fixtureSha256,
    imageDigestSha256: args.imageDigestSha256,
    planSha256: args.planSha256,
    sourceRevision: args.sourceRevision,
  }));
  const client = dependencies.createBatchClient({ endpoint: args.batchEndpoint, token: tokenFile.token });
  const first = await completeVoicetextCanaryBatch(client, fixture, idempotencyKey, dependencies.wait, deadline.signal);
  const replay = await completeVoicetextCanaryBatch(client, fixture, idempotencyKey, dependencies.wait, deadline.signal);
  const batchSegments = voicetextCanaryBatchSegments(first);
  const replaySegments = voicetextCanaryBatchSegments(replay);
  const firstIdentity = voicetextCanaryBatchIdentity(first, batchSegments);
  const replayIdentity = voicetextCanaryBatchIdentity(replay, replaySegments);
  if (JSON.stringify(firstIdentity) !== JSON.stringify(replayIdentity)) {
    throw new Error("Voicetext batch idempotent replay changed its immutable result");
  }

  const liveSegments: CanarySegment[] = [];
  const openingSession = dependencies.openLiveSession({
    endpoint: args.liveEndpoint,
    idempotencyKey,
    onTranscript: (segment, isFinal) => {
      if (isFinal) {liveSegments.push(segment);}
    },
    signal: deadline.signal,
    token: tokenFile.token,
  });
  // A broken connector may resolve after ignoring cancellation. Do not let that
  // late session remain active after this bounded canary has already returned.
  void openingSession.then((lateSession) => {
    if (deadline.signal.aborted) {lateSession.terminate();}
    return null;
  }, () => null);
  const session = await waitForVoicetextCanaryOperation(openingSession, deadline.signal);
  let acknowledged = 0;
  try {
    let relativeTimeMs = 0;
    for (const [index, packet] of packets.entries()) {
      deadline.signal.throwIfAborted();
      const durationSamples48Khz = opusPacketDurationSamples(packet);
      const status = await waitForVoicetextCanaryOperation(session.sendPacket({
        durationSamples48Khz,
        opus: packet,
        packetId: `${args.fixtureSha256}:${String(index)}`,
        relativeTimeMs,
      }), deadline.signal);
      if (status !== "accepted") {
        throw new Error("Voicetext live canary unexpectedly reused a new audio packet");
      }
      acknowledged += 1;
      const durationMs = durationSamples48Khz / 48;
      relativeTimeMs += durationMs;
      // The production stream receives audio in real time. Pace the synthetic
      // fixture likewise so provider flush does not race a burst of future audio.
      await waitForVoicetextCanaryOperation(
        dependencies.wait(durationMs, deadline.signal),
        deadline.signal,
      );
    }
    // Successful finalization is the protocol proof that all outstanding audio
    // acknowledgements were received, not merely that socket writes completed.
    await waitForVoicetextCanaryOperation(session.finalize(), deadline.signal);
  } catch (error: unknown) {
    session.terminate();
    throw error;
  }
  if (liveSegments.length === 0) {
    throw new Error("Voicetext live canary returned no immutable transcript segments");
  }
  const tokenFileAfter = await waitForVoicetextCanaryOperation(
    dependencies.readToken(tokenFilePath), deadline.signal,
  );
  if (!sameTokenFile(tokenFile, tokenFileAfter)) {
    throw new Error("Voicetext token file changed during the semantic canary");
  }
  return {
    batch: {
      firstSubmission: firstIdentity,
      idempotentReplay: replayIdentity,
      segments: batchSegments,
      utteranceCount: first.result.utterances.length,
    },
    live: {
      audioAcknowledgements: { expected: packets.length, received: acknowledged },
      finalizeComplete: true,
      protocolReady: true,
      segments: liveSegments,
    },
    schemaVersion: 1,
    tokenFile: {
      generationId: tokenFile.generationId,
      mode: tokenFile.mode,
      ownerUid: tokenFile.ownerUid,
      path: tokenFile.path,
    },
  };
  } finally {
    deadline.dispose();
  }
}

function sameTokenFile(
  before: Awaited<ReturnType<VoicetextSemanticCanaryDependencies["readToken"]>>,
  after: Awaited<ReturnType<VoicetextSemanticCanaryDependencies["readToken"]>>,
): boolean {
  const beforeTokenSha256 = createHash("sha256").update(before.token, "utf8").digest();
  const afterTokenSha256 = createHash("sha256").update(after.token, "utf8").digest();
  return before.generationId === after.generationId
    && before.ownerUid === after.ownerUid
    && before.path === after.path
    && timingSafeEqual(beforeTokenSha256, afterTokenSha256);
}

function extractOpusPackets(bytes: Uint8Array): readonly Uint8Array[] {
  validateOggOpus(bytes);
  const packets: Uint8Array[] = [];
  let packetParts: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const segmentCount = bytes[offset + 26];
    if (segmentCount === undefined) {throw new Error("Voicetext canary fixture has invalid Ogg lacing");}
    const bodyOffset = offset + 27 + segmentCount;
    let cursor = bodyOffset;
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const length = bytes[offset + 27 + segment];
      if (length === undefined) {throw new Error("Voicetext canary fixture has invalid Ogg lacing");}
      packetParts.push(bytes.slice(cursor, cursor + length));
      cursor += length;
      if (length < 255) {
        packets.push(concatenate(packetParts));
        packetParts = [];
      }
    }
    offset = cursor;
  }
  if (packetParts.length > 0 || packets.length < 3
    || Buffer.from(packets[0] ?? []).subarray(0, 8).toString("ascii") !== "OpusHead"
    || Buffer.from(packets[1] ?? []).subarray(0, 8).toString("ascii") !== "OpusTags") {
    throw new Error("Voicetext canary fixture has an invalid Ogg Opus packet stream");
  }
  return packets.slice(2);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {result.set(part, offset); offset += part.byteLength;}
  return result;
}

function validateArguments(args: VoicetextSemanticCanaryArguments): void {
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
  const digest = /^[a-f\d]{64}$/u;
  if (!identifier.test(args.campaignId) || !digest.test(args.fixtureSha256)
    || !digest.test(args.imageDigestSha256) || !digest.test(args.planSha256)
    || !Number.isSafeInteger(args.deadlineMs) || args.deadlineMs < 1 || args.deadlineMs > 300_000
    || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/u.test(args.sourceRevision)
    || !args.fixturePath.startsWith("/")) {
    throw new Error("Voicetext semantic canary arguments are invalid");
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readPrivateToken(path: string) {
  const currentUid = process.getuid?.();
  if (currentUid === undefined || !path.startsWith("/")) {
    throw new Error("Voicetext token custody is unsupported");
  }
  const pathMetadata = await stat(path, { bigint: false });
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== currentUid || (before.mode & 0o777) !== 0o400
      || before.size < 1 || before.size > tokenFileMaximumBytes
      || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino) {
      throw new Error("Voicetext token file custody is invalid");
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.ctimeMs !== before.ctimeMs || content.byteLength !== before.size) {
      throw new Error("Voicetext token file changed during the canary");
    }
    const token = content.toString("utf8").trim();
    if (token.length < 16 || /\s/u.test(token) || token.includes("\0")) {
      throw new Error("Voicetext token file content is invalid");
    }
    const generationSource = [before.dev, before.ino, before.size, before.ctimeMs].join(":");
    return {
      generationId: `file-${sha256(generationSource)}`,
      mode: 0o400 as const,
      ownerUid: before.uid,
      path,
      token,
    };
  } finally {
    await handle.close();
  }
}

function defaultDependencies(): VoicetextSemanticCanaryDependencies {
  return {
    createBatchClient: (input) => new FetchVoicetextBatchClient(input),
    openLiveSession: async ({ endpoint, idempotencyKey, onTranscript, signal, token }) =>
      await new VoicetextLiveTranscriptionAdapter({ endpoint, language: "multi", token }).openSession({
        idempotencyKey,
        meetingId: `canary:${idempotencyKey}`,
        onTranscript: (event) => {
          onTranscript({ endMs: event.endMs, startMs: event.startMs, text: event.text }, event.isFinal);
        },
        signal,
        speakerId: "canary-speaker",
      }),
    readFixture: async (path) => await readFile(path),
    readToken: readPrivateToken,
    wait: async (delayMs, signal) => {
      await new Promise<void>((resolve, reject) => {
        const complete = () => {signal.removeEventListener("abort", abort); resolve();};
        const timeout = setTimeout(complete, delayMs);
        const abort = () => {clearTimeout(timeout); reject(signal.reason);};
        signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
}

export function parseVoicetextSemanticCanaryArguments(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): { readonly args: VoicetextSemanticCanaryArguments; readonly tokenFilePath: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--json" && index === argv.length - 1) {values.set(flag, "true"); break;}
    if (flag === undefined || value === undefined || !flag.startsWith("--") || values.has(flag)) {
      throw new Error("Voicetext semantic canary CLI arguments are invalid");
    }
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) {throw new Error("Voicetext semantic canary CLI arguments are incomplete");}
    return value;
  };
  const allowed = new Set(["--batch-origin", "--batch-path", "--campaign", "--deadline-ms", "--fixture",
    "--fixture-sha256", "--image-digest-sha256", "--json", "--live-origin", "--live-path",
    "--plan-sha256", "--source-revision"]);
  if (values.get("--json") !== "true" || [...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error("Voicetext semantic canary CLI arguments are invalid");
  }
  const configuredLive = environment.VOICETEXT_WS_URL;
  const tokenFilePath = environment.VOICETEXT_SERVICE_TOKEN_FILE;
  if (configuredLive === undefined || tokenFilePath === undefined) {
    throw new Error("Voicetext semantic canary runtime configuration is incomplete");
  }
  const liveEndpoint = exactEndpoint(required("--live-origin"), required("--live-path"));
  const batchEndpoint = exactEndpoint(required("--batch-origin"), required("--batch-path"));
  if (liveEndpoint !== configuredLive || batchEndpoint !== batchEndpointFromWebSocketUrl(configuredLive)) {
    throw new Error("Voicetext semantic canary endpoints do not match runtime configuration");
  }
  return {
    args: {
      batchEndpoint,
      campaignId: required("--campaign"),
      deadlineMs: exactDeadlineMs(required("--deadline-ms")),
      fixturePath: required("--fixture"),
      fixtureSha256: required("--fixture-sha256"),
      imageDigestSha256: required("--image-digest-sha256"),
      liveEndpoint,
      planSha256: required("--plan-sha256"),
      sourceRevision: required("--source-revision"),
    },
    tokenFilePath,
  };
}

function exactDeadlineMs(value: string): number {
  if (!/^[1-9]\d{0,5}$/u.test(value)) {
    throw new Error("Voicetext semantic canary deadline is invalid");
  }
  const deadlineMs = Number(value);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs > 300_000) {
    throw new Error("Voicetext semantic canary deadline is invalid");
  }
  return deadlineMs;
}

function exactEndpoint(origin: string, path: string): string {
  const originUrl = new URL(origin);
  const endpoint = new URL(path, originUrl);
  if (originUrl.origin !== origin || !path.startsWith("/") || endpoint.origin !== origin) {
    throw new Error("Voicetext semantic canary endpoint is invalid");
  }
  return endpoint.toString();
}

async function main(): Promise<void> {
  const input = parseVoicetextSemanticCanaryArguments(process.argv.slice(2), process.env);
  const result = await runVoicetextSemanticCanary(input.args, input.tokenFilePath, defaultDependencies());
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {process.exitCode = 1;});
}
