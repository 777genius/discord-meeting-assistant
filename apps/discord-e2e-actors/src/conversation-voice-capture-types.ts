export const PCM_S16LE_SAMPLE_RATE_HERTZ = 48_000;
export const PCM_S16LE_CHANNELS = 2;
export const PCM_S16LE_BYTES_PER_SAMPLE = 2;
export const PCM_S16LE_STEREO_BYTES_PER_FRAME =
  PCM_S16LE_CHANNELS * PCM_S16LE_BYTES_PER_SAMPLE;
export const PCM_S16LE_STEREO_BYTES_PER_MILLISECOND =
  (PCM_S16LE_SAMPLE_RATE_HERTZ * PCM_S16LE_STEREO_BYTES_PER_FRAME) / 1_000;
export const MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS = 60_000;
export const MAXIMUM_CONVERSATION_VOICE_PCM_BYTES =
  MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS *
  PCM_S16LE_STEREO_BYTES_PER_MILLISECOND;

export type ConversationVoiceCaptureErrorCode =
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
  readonly purpose: "addressed-answer" | "farewell" | "greeting";
  readonly playbackReceipt?: {
    readonly meetingId: string;
    readonly playbackAttemptId: string;
    readonly startedAt: ConversationVoiceCaptureTimestamp;
    readonly turnId: string;
  };
  readonly recordingId: string | null;
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
    readonly purpose: "addressed-answer" | "farewell" | "greeting";
    readonly recordingId: string | null;
    readonly verification: "not-run";
    readonly turnId: string;
  } | {
    readonly attemptId: string;
    readonly meetingId: string;
    readonly playbackKind: "answer";
    readonly playbackStartedAt: ConversationVoiceCaptureTimestamp;
    readonly provenance: "playback-started-receipt";
    readonly purpose: "addressed-answer";
    readonly recordingId: string | null;
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
  readonly schemaVersion: 3;
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
