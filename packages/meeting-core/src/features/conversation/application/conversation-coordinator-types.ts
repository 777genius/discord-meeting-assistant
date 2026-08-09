import type { ConversationAlias, ConversationSession, ConversationTurn } from "../domain/conversation.js";
import type {
  ConversationDelay,
  ConversationDelayPort,
  ConversationLatencyObserverPort,
  ConversationRuntime,
  ConversationRuntimeTurn,
  ConversationStartRequest,
  ConversationThinkingCue,
  ConversationThinkingCuePort,
  VoicePlaybackPort,
  VoicePlaybackSession,
} from "./ports/conversation.js";

export interface FinalizedConversationTurnInput {
  readonly locale: string;
  readonly meetingId: string;
  readonly nowMs: number;
  readonly recordingId: string;
  readonly speakerId: string;
  readonly systemPrompt: string;
  readonly text: string;
  readonly thinkingCueLocale: string;
  readonly turnEndedAtUnixMs?: number;
  readonly transcriptEndMs: number;
  readonly transcriptStartMs: number;
  readonly turnId: string;
  readonly voiceProfileId: string;
  readonly wakeDetectedAtUnixMs?: number;
}

/** A provider-neutral system-initiated utterance that is not transcript evidence. */
export interface ProactiveConversationTurnInput {
  readonly locale: string;
  readonly meetingId: string;
  readonly nowMs: number;
  readonly prompt: string;
  readonly recordingId: string;
  readonly speakerId: string;
  readonly systemPrompt: string;
  readonly turnId: string;
  readonly voiceProfileId: string;
}

/** Pre-generated 48 kHz mono PCM played without an LLM or TTS round-trip. */
export interface PreparedConversationCueInput {
  readonly cueId: string;
  readonly locale: string;
  readonly meetingId: string;
  readonly nowMs: number;
  readonly pcmChunks: readonly Uint8Array[];
  readonly playbackAttemptId: string;
  readonly recordingId: string;
  readonly speakerId: string;
  readonly turnId: string;
  readonly voiceProfileId: string;
}

export type ConversationCoordinatorResult =
  | { readonly status: "ignored" }
  | {
      readonly alias: ConversationAlias;
      readonly latchExpiresAtTranscriptMs: number;
      readonly status: "awaiting-prompt";
      readonly turnId: string;
    }
  | {
      readonly prompt: string;
      readonly status: "active";
      readonly turnId: string;
      readonly usedFallbackPrompt: boolean;
    }
  | {
      readonly expiresAtMs: number;
      readonly prompt: string;
      readonly status: "queued";
      readonly turnId: string;
      readonly usedFallbackPrompt: boolean;
    }
  | { readonly status: "busy"; readonly turnId: string }
  | {
      readonly disposition:
        | "active"
        | "busy"
        | "cancelled"
        | "cancelling"
        | "completed"
        | "expired"
        | "queued";
      readonly status: "reused";
      readonly turnId: string;
    };

export type ConversationInterruptionResult =
  | { readonly status: "cancel-requested"; readonly turnId: string }
  | { readonly status: "ignored" };

export interface ConversationCoordinatorDependencies {
  readonly delay?: ConversationDelayPort;
  readonly latencyObserver?: ConversationLatencyObserverPort;
  readonly playback: VoicePlaybackPort;
  readonly runtime: ConversationRuntime;
  readonly thinkingCues?: ConversationThinkingCuePort;
}

export interface PreparedConversation {
  readonly cue?: {
    readonly cueId: string;
    readonly pcmChunks: readonly Uint8Array[];
    readonly playbackAttemptId: string;
  };
  readonly request: ConversationStartRequest;
  readonly thinkingCueLocale: string;
  readonly thinkingCuesEnabled: boolean;
  readonly turn: ConversationTurn;
}

/**
 * A per-meeting lease held from playback admission until the transport reports
 * a terminal event. It deliberately remains unresolved when that receipt is
 * missing, so a later answer cannot overlap audio with an unknown predecessor.
 */
export interface ConversationPlaybackFence {
  readonly terminalReceipt: Promise<void>;
  receiptState: "awaiting" | "missing" | "received";
  releaseTerminalReceipt(): void;
}

export interface ActiveConversationRun {
  answerAudioStarted: boolean;
  attemptId: string | null;
  cancellationInFlight: boolean;
  readonly cueDelays: Set<ConversationDelay>;
  cuePlayback: VoicePlaybackSession | null;
  cuePlaybackOpening: boolean;
  deliberationCue: ConversationThinkingCue | null;
  deliberationCueSelectionInFlight: boolean;
  deliberationCueReady: boolean;
  finalized: boolean;
  playback: VoicePlaybackSession | null;
  playbackOpenAbortController: AbortController | null;
  playbackEventsClosed: boolean;
  playbackFinishRequested: boolean;
  playbackFinished: boolean;
  playbackTerminalFinalizationScheduled: boolean;
  playbackTerminalReceiptMissing: boolean;
  readonly prepared: PreparedConversation;
  runtimeCompleted: boolean;
  runtimeStartAbortController: AbortController | null;
  runtimeTurn: ConversationRuntimeTurn | null;
}

export interface MeetingConversationState {
  active: ActiveConversationRun | null;
  closing: boolean;
  lastObservedAtMs: number;
  readonly latestWakeAtBySpeaker: Map<string, number>;
  readonly pending: Map<string, PreparedConversation>;
  playbackFence: ConversationPlaybackFence | null;
  playbackOpenBarrier: Promise<void>;
  readonly session: ConversationSession;
  readonly tasks: Set<Promise<void>>;
  readonly wakeLatches: Map<string, ConversationWakeLatch>;
  readonly wakeTurnReceipts: Map<string, ConversationWakeTurnReceipt>;
}

interface ConversationWakeLatch {
  readonly armedAtTranscriptMs: number;
  readonly expiresAtTranscriptMs: number;
  readonly turnId: string;
}

export interface ConversationWakeTurnReceipt extends ConversationWakeLatch {
  readonly alias: ConversationAlias;
  readonly speakerId: string;
}
