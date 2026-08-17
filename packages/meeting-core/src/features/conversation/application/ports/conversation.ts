export interface ConversationFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type ConversationPortResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly failure: ConversationFailure; readonly ok: false };

export type ConversationCancellationReason =
  | "barge-in"
  | "disconnected"
  | "meeting-ended"
  | "playback-failed"
  | "runtime-shutdown"
  | "superseded";

export interface ConversationStartRequest {
  readonly idempotencyKey: string;
  readonly latency?: {
    readonly turnEndedAtUnixMs: number;
    readonly wakeDetectedAtUnixMs: number;
  };
  readonly locale: string;
  /** Exact text to synthesize without model generation. */
  readonly literalSpeech?: string;
  readonly meetingId: string;
  readonly prompt: string;
  readonly recordingId: string;
  readonly speakerId: string;
  readonly systemPrompt: string;
  readonly turnId: string;
  readonly voiceProfileId: string;
}

export interface ConversationAudioChunk {
  readonly attemptId: string;
  readonly bytes: Uint8Array;
  readonly channels: 1;
  readonly format: "pcm_s16le";
  readonly sampleRateHz: 48_000;
  readonly sequence: number;
  readonly turnId: string;
}

export type ConversationRuntimeEvent =
  | { readonly attemptId: string; readonly type: "accepted" }
  | { readonly attemptId: string; readonly text: string; readonly type: "text-delta" }
  | {
      readonly attemptId: string;
      readonly channels: 1;
      readonly format: "pcm_s16le";
      readonly sampleRateHz: 48_000;
      readonly type: "audio-start";
    }
  | ({ readonly type: "audio-chunk" } & ConversationAudioChunk)
  | { readonly attemptId: string; readonly type: "audio-end" }
  | {
      readonly attemptId: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
      readonly type: "usage";
    }
  | {
      readonly attemptId: string;
      readonly endTurnToWakeMs: number;
      readonly firstLlmTokenToAudioMs: number;
      readonly totalToFirstAudioMs: number;
      readonly type: "latency";
      readonly wakeToFirstLlmTokenMs: number;
    }
  | { readonly attemptId: string; readonly type: "completed" }
  | {
      readonly attemptId: string;
      readonly reason: ConversationCancellationReason;
      readonly type: "cancelled";
    }
  | { readonly attemptId: string; readonly failure: ConversationFailure; readonly type: "failed" };

export interface ConversationRuntimeTurn {
  readonly events: AsyncIterable<ConversationRuntimeEvent>;

  cancel(reason: ConversationCancellationReason): Promise<void>;
}

export interface ConversationStartOptions {
  readonly signal?: AbortSignal;
}

/**
 * Conversation-owned request vocabulary for grounded meeting knowledge. The
 * provider boundary deliberately contains only participant, room, meeting and
 * question primitives; published Meeting Knowledge, database and model types
 * cannot cross this port.
 */
export interface GroundedKnowledgeAnswerRequest {
  readonly locale: string;
  readonly meetingId: string;
  readonly participantId: string;
  readonly question: string;
  readonly roomId: string;
}

export interface GroundedKnowledgeAnswerOptions {
  /** The same active-turn signal used by generation and speech startup. */
  readonly signal: AbortSignal;
}

export interface GroundedKnowledgePlaybackAuthorityRequest {
  readonly citationTurnIds: readonly string[];
  readonly evidenceEpoch: string;
  readonly knowledgeEpoch: string;
  readonly request: GroundedKnowledgeAnswerRequest;
}

/** Consumer-owned port. Its untrusted complete result is validated by Conversation. */
export interface GroundedKnowledgeAnswerPort {
  answer(
    request: GroundedKnowledgeAnswerRequest,
    options: GroundedKnowledgeAnswerOptions,
  ): Promise<ConversationPortResult<unknown>>;

  /**
   * Fresh source authorization and canonical-memory watermark fence. Conversation
   * invokes it after TTS has produced a complete first chunk but before that PCM
   * can cross the playback boundary.
   */
  recheckPlaybackAuthority(
    request: GroundedKnowledgePlaybackAuthorityRequest,
    options: GroundedKnowledgeAnswerOptions,
  ): Promise<ConversationPortResult<"current">>;
}

export type GroundedKnowledgeAnswerObservation =
  | {
      readonly citationTurnIds: readonly string[];
      readonly evidenceEpoch: string;
      readonly knowledgeEpoch: string;
      readonly meetingId: string;
      readonly participantId: string;
      readonly playbackProvenance: "literal_tts";
      readonly status: "validated";
      readonly turnId: string;
    }
  | {
      readonly meetingId: string;
      readonly reason: ConversationCancellationReason;
      readonly status: "cancelled";
      readonly turnId: string;
    };

/** Consumer-owned privacy-safe evidence sink for grounded factual turns. */
export interface GroundedKnowledgeAnswerObserverPort {
  observeGroundedKnowledgeAnswer(
    observation: GroundedKnowledgeAnswerObservation,
  ): void | Promise<void>;
}

export interface ConversationRuntime {
  startTurn(
    request: ConversationStartRequest,
    options?: ConversationStartOptions,
  ): Promise<ConversationPortResult<ConversationRuntimeTurn>>;
}

export interface ConversationLatencyObservation {
  readonly attemptId: string;
  readonly endTurnToWakeMs: number;
  readonly firstLlmTokenToAudioMs: number;
  readonly meetingId: string;
  readonly totalToFirstAudioMs: number;
  readonly turnId: string;
  readonly wakeToFirstLlmTokenMs: number;
}

/** Consumer-owned sink for provider-neutral first-audio latency telemetry. */
export interface ConversationLatencyObserverPort {
  observeConversationLatency(
    observation: ConversationLatencyObservation,
  ): void | Promise<void>;
}

export type ConversationPlaybackKind = "answer" | "prepared-cue" | "thinking-cue";

export type ConversationPlaybackSettlement =
  | "played"
  | "unplayed"
  | "partial"
  | "unknown";

export type ConversationPlaybackObservation =
  | {
      readonly preparedAssetSha256?: string;
      readonly thinkingCuePcmSha256?: string;
      readonly speechProvenance?: "literal_tts" | "model_tts";
      readonly meetingId: string;
      readonly playbackAttemptId: string;
      readonly playbackKind: ConversationPlaybackKind;
      readonly startedAtMs: number;
      readonly status: "started";
      readonly turnId: string;
    }
  | {
      readonly preparedAssetSha256?: string;
      readonly thinkingCuePcmSha256?: string;
      readonly speechProvenance?: "literal_tts" | "model_tts";
      readonly finishedAtMs: number;
      readonly meetingId: string;
      readonly playbackAttemptId: string;
      readonly playbackKind: ConversationPlaybackKind;
      readonly status: "finished";
      readonly turnId: string;
    }
  | {
      readonly preparedAssetSha256?: string;
      readonly thinkingCuePcmSha256?: string;
      readonly speechProvenance?: "literal_tts" | "model_tts";
      readonly meetingId: string;
      readonly playbackAttemptId: string;
      readonly playbackKind: ConversationPlaybackKind;
      readonly settledAtMs: number;
      readonly settlement: ConversationPlaybackSettlement;
      readonly status: "settled";
      readonly turnId: string;
    };

/** Consumer-owned sink for privacy-safe, provider-neutral playback receipts. */
export interface ConversationPlaybackObserverPort {
  observeConversationPlayback(
    observation: ConversationPlaybackObservation,
  ): void | Promise<void>;
}

interface ConversationPlaybackReadinessRequestBase {
  readonly meetingId: string;
  readonly participantId?: string;
  readonly playbackAttemptId: string;
  readonly turnId: string;
}

export type ConversationPlaybackReadinessRequest =
  | ConversationPlaybackReadinessRequestBase & {
      readonly expectedPcmBytes: number;
      readonly expectedPcmSha256: string;
      readonly playbackKind: "thinking-cue";
    }
  | ConversationPlaybackReadinessRequestBase & {
      readonly expectedPcmBytes?: never;
      readonly expectedPcmSha256?: never;
      readonly playbackKind: Exclude<ConversationPlaybackKind, "thinking-cue">;
    };

/** Optional two-phase gate used when an external observer must be ready first. */
export interface ConversationPlaybackReadinessPort {
  awaitConversationPlaybackReady(
    request: ConversationPlaybackReadinessRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ConversationPortResult<"ready">>;
}

export interface VoicePlaybackRequest {
  readonly attemptId: string;
  readonly meetingId: string;
  readonly recordingId: string;
  readonly turnId: string;
}

export interface VoicePlaybackSession {
  readonly events: AsyncIterable<VoicePlaybackEvent>;

  write(chunk: ConversationAudioChunk): Promise<ConversationPortResult<"accepted" | "reused">>;

  finish(): Promise<ConversationPortResult<"finished" | "reused">>;

  cancel(
    reason: ConversationCancellationReason,
  ): Promise<ConversationPortResult<"cancelled" | "reused">>;
}

export type VoicePlaybackEvent =
  | { readonly attemptId: string; readonly startedAtMs: number; readonly type: "started" }
  | { readonly attemptId: string; readonly finishedAtMs: number; readonly type: "finished" }
  | { readonly attemptId: string; readonly failure: ConversationFailure; readonly type: "failed" };

export interface VoicePlaybackPort {
  open(
    request: VoicePlaybackRequest,
    options?: VoicePlaybackOpenOptions,
  ): Promise<ConversationPortResult<VoicePlaybackSession>>;
}

export interface VoicePlaybackOpenOptions {
  readonly signal?: AbortSignal;
}

export interface ConversationDelay {
  readonly elapsed: Promise<"cancelled" | "elapsed">;

  cancel(): void;
}

export interface ConversationDelayPort {
  start(delayMs: number): ConversationDelay;
}

export interface ConversationThinkingCue {
  readonly cueId: string;
  readonly playbackAttemptId: string;
  readonly pcmChunks: readonly Uint8Array[];
  readonly pcmSha256: string;
}

export type ConversationThinkingCueStage = "acknowledgement" | "deliberation";

export interface ConversationThinkingCueRequest {
  readonly locale: string;
  readonly meetingId: string;
  readonly stage: ConversationThinkingCueStage;
  readonly turnId: string;
  readonly voiceProfileId: string;
}

export interface ConversationThinkingCuePort {
  select(
    request: ConversationThinkingCueRequest,
  ): Promise<ConversationPortResult<ConversationThinkingCue | null>>;
}
