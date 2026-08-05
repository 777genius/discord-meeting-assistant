import type { StageFailure } from "../../domain/meeting.js";
import type { PortResult } from "./shared.js";

export type ConversationCancellationReason =
  | "barge-in"
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
  | { readonly attemptId: string; readonly failure: StageFailure; readonly type: "failed" };

export interface ConversationRuntimeTurn {
  readonly events: AsyncIterable<ConversationRuntimeEvent>;

  cancel(reason: ConversationCancellationReason): Promise<void>;
}

export interface ConversationStartOptions {
  readonly signal?: AbortSignal;
}

export interface ConversationRuntime {
  startTurn(
    request: ConversationStartRequest,
    options?: ConversationStartOptions,
  ): Promise<PortResult<ConversationRuntimeTurn>>;
}

export interface ConversationLatencyObservation {
  readonly attemptId: string;
  readonly endTurnToWakeMs: number;
  readonly firstLlmTokenToAudioMs: number;
  readonly meetingId: string;
  readonly speakerId: string;
  readonly totalToFirstAudioMs: number;
  readonly turnId: string;
  readonly wakeToFirstLlmTokenMs: number;
}

/** Consumer-owned sink for provider-neutral first-audio latency telemetry. */
export interface ConversationLatencyObserverPort {
  observeConversationLatency(observation: ConversationLatencyObservation): void;
}

export interface VoicePlaybackRequest {
  readonly attemptId: string;
  readonly meetingId: string;
  readonly recordingId: string;
  readonly turnId: string;
}

export interface VoicePlaybackSession {
  readonly events: AsyncIterable<VoicePlaybackEvent>;

  write(chunk: ConversationAudioChunk): Promise<PortResult<"accepted" | "reused">>;

  finish(): Promise<PortResult<"finished" | "reused">>;

  cancel(
    reason: ConversationCancellationReason,
  ): Promise<PortResult<"cancelled" | "reused">>;
}

export type VoicePlaybackEvent =
  | { readonly attemptId: string; readonly startedAtMs: number; readonly type: "started" }
  | { readonly attemptId: string; readonly finishedAtMs: number; readonly type: "finished" }
  | { readonly attemptId: string; readonly failure: StageFailure; readonly type: "failed" };

export interface VoicePlaybackPort {
  open(
    request: VoicePlaybackRequest,
    options?: VoicePlaybackOpenOptions,
  ): Promise<PortResult<VoicePlaybackSession>>;
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
  ): Promise<PortResult<ConversationThinkingCue | null>>;
}
