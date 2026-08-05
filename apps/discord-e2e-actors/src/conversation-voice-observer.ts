import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";

export const PCM_S16LE_SAMPLE_RATE_HERTZ = 48_000;
export const PCM_S16LE_CHANNELS = 2;
const PCM_S16LE_BYTES_PER_SAMPLE = 2;
const PCM_S16LE_STEREO_BYTES_PER_FRAME =
  PCM_S16LE_CHANNELS * PCM_S16LE_BYTES_PER_SAMPLE;
export const PCM_S16LE_STEREO_BYTES_PER_MILLISECOND =
  (PCM_S16LE_SAMPLE_RATE_HERTZ * PCM_S16LE_STEREO_BYTES_PER_FRAME) / 1_000;
export const MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS = 60_000;
export const MAXIMUM_CONVERSATION_VOICE_PCM_BYTES =
  MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS *
  PCM_S16LE_STEREO_BYTES_PER_MILLISECOND;

type ConversationVoiceCaptureErrorCode =
  | "capture-not-started"
  | "capture-timeout"
  | "expected-duration-exceeded"
  | "invalid-pcm"
  | "no-audio"
  | "opus-decode-failed"
  | "output-exists"
  | "pcm-byte-limit-exceeded"
  | "silent-pcm";

export class ConversationVoiceCaptureError extends Error {
  public constructor(
    public readonly code: ConversationVoiceCaptureErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConversationVoiceCaptureError";
  }
}

export interface ConversationVoiceCaptureTimestamp {
  readonly epochMilliseconds: number;
  readonly monotonicMilliseconds: number;
}

export interface ConversationVoiceOpusDecoder {
  decode(opusPacket: Uint8Array): Uint8Array;
}

export interface ConversationVoiceCaptureOptions {
  readonly captureTimeoutMilliseconds: number;
  readonly expectedDuration: {
    readonly maximumMilliseconds: number;
    readonly minimumMilliseconds: number;
  };
  readonly maxPcmBytes: number;
  readonly nonSilenceThresholdSample?: number;
}

export interface ConversationVoicePacketInput {
  readonly opusPacket: Uint8Array;
  readonly sequence: number;
  readonly timing: ConversationVoiceCaptureTimestamp;
}

export type ConversationVoicePacketResult =
  | { readonly kind: "accepted"; readonly captureComplete: boolean }
  | { readonly kind: "ignored-after-completion" }
  | { readonly kind: "ignored-duplicate" }
  | { readonly kind: "ignored-late" };

export interface ConversationVoiceCaptureSummary {
  readonly acceptedDurationMilliseconds: number;
  readonly acceptedPacketCount: number;
  readonly endedAt: ConversationVoiceCaptureTimestamp;
  readonly firstPacketAt: ConversationVoiceCaptureTimestamp;
  readonly ignoredDuplicatePacketCount: number;
  readonly ignoredLatePacketCount: number;
  readonly pcm: {
    readonly byteLength: number;
    readonly channels: typeof PCM_S16LE_CHANNELS;
    readonly encoding: "s16le";
    readonly nonSilence: {
      readonly sampleCount: number;
      readonly sampleCountAboveThreshold: number;
      readonly sampleRatioAboveThreshold: number;
      readonly thresholdSample: number;
    };
    readonly rms: number;
    readonly sampleRateHertz: typeof PCM_S16LE_SAMPLE_RATE_HERTZ;
    readonly sha256: string;
  };
  readonly startedAt: ConversationVoiceCaptureTimestamp;
}

export interface ConversationVoiceEvidenceInput {
  readonly attemptId: string;
  readonly authenticatedBotId: string;
  readonly capture: ConversationVoiceCaptureSummary;
  readonly captureTimeoutMilliseconds: number;
  readonly craigBotId: string;
  readonly expectedDuration: {
    readonly maximumMilliseconds: number;
    readonly minimumMilliseconds: number;
  };
  readonly guildId: string;
  readonly maxPcmBytes: number;
  readonly observerApplicationId: string;
  readonly privateTestGuildConfirmed: true;
  readonly recordingId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly voiceChannelId: string;
}

export interface ConversationVoiceEvidence {
  readonly capture: {
    readonly acceptedDurationMilliseconds: number;
    readonly acceptedPacketCount: number;
    readonly cancellation: {
      readonly status: "not-observed";
    };
    readonly endedAt: ConversationVoiceCaptureTimestamp;
    readonly expectedDuration: {
      readonly maximumMilliseconds: number;
      readonly minimumMilliseconds: number;
    };
    readonly firstPacketAt: ConversationVoiceCaptureTimestamp;
    readonly ignoredDuplicatePacketCount: number;
    readonly ignoredLatePacketCount: number;
    readonly limits: {
      readonly captureTimeoutMilliseconds: number;
      readonly maxCaptureDurationMilliseconds: typeof MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS;
      readonly maxPcmBytes: number;
    };
    readonly pcm: ConversationVoiceCaptureSummary["pcm"];
    readonly startedAt: ConversationVoiceCaptureTimestamp;
    readonly termination: "expected-duration-reached";
  };
  readonly correlation: {
    readonly attemptId: string;
    readonly provenance: "operator-supplied";
    readonly recordingId: string;
    readonly verification: "not-run";
    readonly turnId: string;
  };
  readonly kind: "conversation-voice-observer-evidence";
  readonly observer: {
    readonly applicationId: string;
    readonly authenticatedBotId: string;
    readonly guildId: string;
    readonly privateTestGuildConfirmed: true;
    readonly voiceChannelId: string;
  };
  readonly runId: string;
  readonly schemaVersion: 2;
  readonly source: {
    readonly codec: "opus";
    readonly craigBotId: string;
    readonly decodedPcm: {
      readonly channels: typeof PCM_S16LE_CHANNELS;
      readonly encoding: "s16le";
      readonly sampleRateHertz: typeof PCM_S16LE_SAMPLE_RATE_HERTZ;
    };
    readonly receiver: "@discordjs/voice";
  };
  readonly transcriptVerification: {
    readonly status: "not-run";
  };
}

const defaultNonSilenceThresholdSample = 256;

/**
 * An in-memory bounded PCM analyzer. It accepts no Discord types so its timing,
 * packet ordering, duration, and silence behavior remain deterministic in tests.
 */
export class ConversationVoiceCaptureController {
  readonly #captureDeadlineOffsetMilliseconds: number;
  readonly #decoder: ConversationVoiceOpusDecoder;
  readonly #expectedDuration: ConversationVoiceCaptureOptions["expectedDuration"];
  readonly #hash = createHash("sha256");
  readonly #maxPcmBytes: number;
  readonly #nonSilenceThresholdSample: number;
  #acceptedPacketCount = 0;
  #acceptedPcmByteLength = 0;
  #captureComplete = false;
  #firstPacketAt: ConversationVoiceCaptureTimestamp | undefined;
  #ignoredDuplicatePacketCount = 0;
  #ignoredLatePacketCount = 0;
  #lastSequence = 0;
  #nonSilentSampleCount = 0;
  #sampleCount = 0;
  #sampleSquareSum = 0;
  #startedAt: ConversationVoiceCaptureTimestamp | undefined;
  #summary: ConversationVoiceCaptureSummary | undefined;

  public constructor(
    options: ConversationVoiceCaptureOptions,
    decoder: ConversationVoiceOpusDecoder,
  ) {
    assertCaptureOptions(options);
    this.#captureDeadlineOffsetMilliseconds = options.captureTimeoutMilliseconds;
    this.#decoder = decoder;
    this.#expectedDuration = Object.freeze({ ...options.expectedDuration });
    this.#maxPcmBytes = options.maxPcmBytes;
    this.#nonSilenceThresholdSample = options.nonSilenceThresholdSample ?? defaultNonSilenceThresholdSample;
  }

  public start(timing: ConversationVoiceCaptureTimestamp): void {
    if (this.#startedAt !== undefined) {
      throw new Error("Conversation voice capture has already started");
    }
    assertTimestamp(timing, "capture start");
    this.#startedAt = Object.freeze({ ...timing });
  }

  public acceptPacket(input: ConversationVoicePacketInput): ConversationVoicePacketResult {
    const startedAt = this.#startedAt;
    if (startedAt === undefined) {
      throw new ConversationVoiceCaptureError("capture-not-started", "Conversation voice capture has not started");
    }
    assertPacketInput(input);
    if (this.#captureComplete) {
      return Object.freeze({ kind: "ignored-after-completion" as const });
    }
    if (input.sequence <= this.#lastSequence) {
      this.#ignoredDuplicatePacketCount += 1;
      return Object.freeze({ kind: "ignored-duplicate" as const });
    }
    this.#lastSequence = input.sequence;
    const captureDeadlineMilliseconds = startedAt.monotonicMilliseconds + this.#captureDeadlineOffsetMilliseconds;
    if (
      input.timing.monotonicMilliseconds < startedAt.monotonicMilliseconds ||
      input.timing.monotonicMilliseconds > captureDeadlineMilliseconds
    ) {
      this.#ignoredLatePacketCount += 1;
      return Object.freeze({ kind: "ignored-late" as const });
    }

    const pcm = decodePcm(this.#decoder, input.opusPacket);
    assertPcm(pcm);
    const nextPcmByteLength = this.#acceptedPcmByteLength + pcm.byteLength;
    if (nextPcmByteLength > this.#maxPcmBytes) {
      throw new ConversationVoiceCaptureError(
        "pcm-byte-limit-exceeded",
        "Conversation voice capture exceeded its PCM byte limit",
      );
    }
    const nextDurationMilliseconds = pcmDurationMilliseconds(nextPcmByteLength);
    if (nextDurationMilliseconds > this.#expectedDuration.maximumMilliseconds) {
      throw new ConversationVoiceCaptureError(
        "expected-duration-exceeded",
        "Conversation voice capture exceeded its expected duration bound",
      );
    }

    if (this.#firstPacketAt === undefined) {
      this.#firstPacketAt = Object.freeze({ ...input.timing });
    }
    this.#hash.update(pcm);
    this.#acceptedPacketCount += 1;
    this.#acceptedPcmByteLength = nextPcmByteLength;
    this.#analyzePcm(pcm);
    this.#captureComplete = nextDurationMilliseconds >= this.#expectedDuration.minimumMilliseconds;
    return Object.freeze({
      kind: "accepted" as const,
      captureComplete: this.#captureComplete,
    });
  }

  public complete(timing: ConversationVoiceCaptureTimestamp): ConversationVoiceCaptureSummary {
    if (this.#summary !== undefined) {
      return this.#summary;
    }
    const startedAt = this.#startedAt;
    if (startedAt === undefined) {
      throw new ConversationVoiceCaptureError("capture-not-started", "Conversation voice capture has not started");
    }
    assertTimestamp(timing, "capture end");
    if (timing.monotonicMilliseconds < startedAt.monotonicMilliseconds) {
      throw new Error("Conversation voice capture end predates its start");
    }
    if (this.#acceptedPacketCount === 0 || this.#firstPacketAt === undefined) {
      throw new ConversationVoiceCaptureError("no-audio", "Conversation voice capture received no Craig audio");
    }
    if (
      timing.monotonicMilliseconds >
        startedAt.monotonicMilliseconds + this.#captureDeadlineOffsetMilliseconds
    ) {
      throw new ConversationVoiceCaptureError(
        "capture-timeout",
        "Conversation voice capture exceeded its timeout bound",
      );
    }
    if (!this.#captureComplete) {
      throw new ConversationVoiceCaptureError(
        "capture-timeout",
        "Conversation voice capture ended before its expected duration",
      );
    }
    if (this.#nonSilentSampleCount === 0) {
      throw new ConversationVoiceCaptureError(
        "silent-pcm",
        "Conversation voice capture contained no non-silent PCM samples",
      );
    }
    const sampleRatioAboveThreshold = this.#nonSilentSampleCount / this.#sampleCount;
    this.#summary = Object.freeze({
      acceptedDurationMilliseconds: pcmDurationMilliseconds(this.#acceptedPcmByteLength),
      acceptedPacketCount: this.#acceptedPacketCount,
      endedAt: Object.freeze({ ...timing }),
      firstPacketAt: this.#firstPacketAt,
      ignoredDuplicatePacketCount: this.#ignoredDuplicatePacketCount,
      ignoredLatePacketCount: this.#ignoredLatePacketCount,
      pcm: Object.freeze({
        byteLength: this.#acceptedPcmByteLength,
        channels: PCM_S16LE_CHANNELS,
        encoding: "s16le" as const,
        nonSilence: Object.freeze({
          sampleCount: this.#sampleCount,
          sampleCountAboveThreshold: this.#nonSilentSampleCount,
          sampleRatioAboveThreshold,
          thresholdSample: this.#nonSilenceThresholdSample,
        }),
        rms: Math.sqrt(this.#sampleSquareSum / this.#sampleCount) / 32_768,
        sampleRateHertz: PCM_S16LE_SAMPLE_RATE_HERTZ,
        sha256: this.#hash.digest("hex"),
      }),
      startedAt,
    });
    return this.#summary;
  }

  #analyzePcm(pcm: Uint8Array): void {
    const data = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let offset = 0; offset < pcm.byteLength; offset += PCM_S16LE_BYTES_PER_SAMPLE) {
      const sample = data.getInt16(offset, true);
      this.#sampleCount += 1;
      this.#sampleSquareSum += sample * sample;
      if (Math.abs(sample) >= this.#nonSilenceThresholdSample) {
        this.#nonSilentSampleCount += 1;
      }
    }
  }
}

export async function assertConversationVoiceEvidencePathIsNew(outputPath: string): Promise<void> {
  try {
    await lstat(outputPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  throw new ConversationVoiceCaptureError(
    "output-exists",
    "Conversation voice observer output already exists and will not be replaced",
  );
}

export async function writeNewConversationVoiceEvidenceAtomically(
  outputPath: string,
  evidence: ConversationVoiceEvidence,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  let temporaryHandle: FileHandle | undefined;
  let published = false;
  try {
    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(evidence, undefined, 2)}\n`, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await chmod(temporaryPath, 0o600);
    await link(temporaryPath, outputPath);
    published = true;
    await unlink(temporaryPath).catch(() => {});
  } catch (error) {
    await temporaryHandle?.close().catch(() => {});
    if (!published) {
      await unlink(temporaryPath).catch(() => {});
    }
    if (isOutputCollisionError(error)) {
      throw new ConversationVoiceCaptureError(
        "output-exists",
        "Conversation voice observer output already exists and will not be replaced",
        { cause: error },
      );
    }
    throw error;
  }
}

function assertCaptureOptions(options: ConversationVoiceCaptureOptions): void {
  const { captureTimeoutMilliseconds, expectedDuration, maxPcmBytes, nonSilenceThresholdSample } = options;
  if (
    !Number.isSafeInteger(captureTimeoutMilliseconds) ||
    captureTimeoutMilliseconds <= 0 ||
    captureTimeoutMilliseconds > MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS
  ) {
    throw new Error("Conversation voice capture timeout is outside its safe bound");
  }
  if (
    !Number.isSafeInteger(expectedDuration.minimumMilliseconds) ||
    !Number.isSafeInteger(expectedDuration.maximumMilliseconds) ||
    expectedDuration.minimumMilliseconds <= 0 ||
    expectedDuration.minimumMilliseconds > expectedDuration.maximumMilliseconds ||
    expectedDuration.maximumMilliseconds > MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS
  ) {
    throw new Error("Conversation voice expected duration is outside its safe bound");
  }
  if (captureTimeoutMilliseconds < expectedDuration.minimumMilliseconds) {
    throw new Error("Conversation voice timeout cannot satisfy its expected duration");
  }
  if (
    !Number.isSafeInteger(maxPcmBytes) ||
    maxPcmBytes <= 0 ||
    maxPcmBytes > MAXIMUM_CONVERSATION_VOICE_PCM_BYTES ||
    maxPcmBytes % PCM_S16LE_STEREO_BYTES_PER_FRAME !== 0
  ) {
    throw new Error("Conversation voice PCM byte bound is invalid");
  }
  if (maxPcmBytes < expectedDuration.maximumMilliseconds * PCM_S16LE_STEREO_BYTES_PER_MILLISECOND) {
    throw new Error("Conversation voice PCM byte bound cannot cover its expected duration");
  }
  if (
    nonSilenceThresholdSample !== undefined &&
    (!Number.isSafeInteger(nonSilenceThresholdSample) ||
      nonSilenceThresholdSample < 1 ||
      nonSilenceThresholdSample > 32_767)
  ) {
    throw new Error("Conversation voice non-silence threshold is invalid");
  }
}

function assertPacketInput(input: ConversationVoicePacketInput): void {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error("Conversation voice packet sequence is invalid");
  }
  if (input.opusPacket.byteLength === 0) {
    throw new Error("Conversation voice Opus packet is empty");
  }
  assertTimestamp(input.timing, "packet");
}

function assertPcm(pcm: Uint8Array): void {
  if (pcm.byteLength === 0 || pcm.byteLength % PCM_S16LE_STEREO_BYTES_PER_FRAME !== 0) {
    throw new ConversationVoiceCaptureError(
      "invalid-pcm",
      "Conversation voice decoder returned incomplete PCM frames",
    );
  }
}

function assertTimestamp(timing: ConversationVoiceCaptureTimestamp, label: string): void {
  if (
    !Number.isSafeInteger(timing.epochMilliseconds) ||
    timing.epochMilliseconds < 0 ||
    !Number.isSafeInteger(timing.monotonicMilliseconds) ||
    timing.monotonicMilliseconds < 0
  ) {
    throw new Error(`Conversation voice ${label} timestamp is invalid`);
  }
}

function decodePcm(decoder: ConversationVoiceOpusDecoder, opusPacket: Uint8Array): Uint8Array {
  try {
    return decoder.decode(opusPacket);
  } catch (error) {
    throw new ConversationVoiceCaptureError(
      "opus-decode-failed",
      "Conversation voice Opus decoder rejected a Craig packet",
      { cause: error },
    );
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isOutputCollisionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function pcmDurationMilliseconds(byteLength: number): number {
  return byteLength / PCM_S16LE_STEREO_BYTES_PER_MILLISECOND;
}
