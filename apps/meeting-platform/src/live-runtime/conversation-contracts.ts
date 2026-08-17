import type {
  ConversationFarewellClassificationInput,
  ConversationFarewellClassifier,
  ConversationFarewellCueRegistry,
  ConversationFarewellTurn,
} from "@discord-meeting/meeting-core/conversation";

type LiveConversationOutcome =
  | {
      readonly status:
        | "ignored"
        | "awaiting-prompt"
        | "active"
        | "queued"
        | "busy";
    }
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
    };

interface LiveConversationTurnInput {
  readonly locale: string;
  readonly meetingId: string;
  readonly nowMs: number;
  readonly recordingId: string;
  readonly roomId: string;
  readonly speakerId: string;
  readonly systemPrompt: string;
  readonly text: string;
  readonly thinkingCueLocale: string;
  readonly turnEndedAtUnixMs: number;
  readonly transcriptEndMs: number;
  readonly transcriptStartMs: number;
  readonly turnId: string;
  readonly voiceProfileId: string;
  readonly wakeDetectedAtUnixMs: number;
}

interface LiveProactiveConversationTurnInput {
  readonly interruptible?: boolean;
  readonly locale: string;
  readonly literalSpeech?: string;
  readonly meetingId: string;
  readonly nowMs: number;
  readonly prompt: string;
  readonly recordingId: string;
  readonly speakerId: string;
  readonly systemPrompt: string;
  readonly turnId: string;
  readonly voiceProfileId: string;
}

interface LivePreparedConversationCueInput {
  readonly assetSha256?: string;
  readonly cueId: string;
  readonly interruptible?: boolean;
  readonly locale: string;
  readonly meetingId: string;
  readonly nowMs: number;
  readonly pcmChunks: readonly Uint8Array[];
  readonly playbackAttemptId: string;
  readonly preemptive?: boolean;
  readonly recordingId: string;
  readonly speakerId: string;
  readonly turnId: string;
  readonly voiceProfileId: string;
}

interface LiveConversationCoordinator {
  advanceMeeting(meetingId: string, nowMs: number): void;
  closeMeeting(meetingId: string, nowMs: number): Promise<void>;
  disconnectMeeting(meetingId: string, nowMs: number): Promise<void>;
  participantLeft?(
    meetingId: string,
    participantId: string,
    nowMs: number,
  ): Promise<void>;
  handleFinalizedTurn(
    input: LiveConversationTurnInput,
  ): Promise<LiveConversationOutcome>;
  handleProactiveTurn(
    input: LiveProactiveConversationTurnInput,
  ): Promise<LiveConversationOutcome>;
  playPreparedCue(
    input: LivePreparedConversationCueInput,
  ): Promise<LiveConversationOutcome>;
  speechActivity(meetingId: string, nowMs: number): Promise<unknown>;
  speechEnded(meetingId: string, nowMs: number): Promise<unknown>;
  speechStarted(meetingId: string, nowMs: number): Promise<unknown>;
  whenIdle(meetingId: string): Promise<void>;
  whenTurnPlaybackStarted(
    meetingId: string,
    turnId: string,
  ): Promise<
    | { readonly startedAtMs: number; readonly status: "started" }
    | { readonly status: "unplayed" }
    | { readonly status: "unknown" }
  >;
  whenTurnPlaybackSettled(
    meetingId: string,
    turnId: string,
  ): Promise<"played" | "unplayed" | "partial" | "unknown">;
}

export interface LiveParticipantGreetingProfile {
  readonly displayName: string;
  readonly greetingLocale: "en" | "ru";
  readonly spokenName: string;
}

interface LiveParticipantGreetingConfiguration {
  readonly cues?: {
    select(input: {
      readonly locale: "en" | "ru";
      readonly meetingId: string;
      readonly participantId: string;
      readonly speech: string;
      readonly voiceProfileId: string;
    }): {
      readonly assetSha256?: string;
      readonly cueId: string;
      readonly pcmChunks: readonly Uint8Array[];
      readonly playbackAttemptId: string;
    } | null;
  };
  readonly defaultLocale: "en" | "ru";
  readonly excludedParticipantIds: readonly string[];
  readonly isPlaybackReady: (recordingId: string) => boolean;
  readonly profiles: Readonly<Record<string, LiveParticipantGreetingProfile>>;
}

export type LiveConversationOneShotReceiptReservation =
  | { readonly status: "completed" | "in_flight" }
  | { readonly leaseToken: string; readonly status: "reserved" };

export interface LiveConversationOneShotReceiptPort {
  /** Greeting-only durable transition immediately before provider invocation. */
  beginGreetingAttempt?(input: {
    readonly kind: "greeting";
    readonly leaseToken: string;
    readonly meetingId: string;
    readonly subjectId: string;
  }): Promise<void>;
  complete(input: {
    readonly kind: "farewell" | "greeting";
    readonly leaseToken: string;
    readonly meetingId: string;
    readonly subjectId: string;
  }): Promise<void>;
  release(input: {
    readonly kind: "farewell" | "greeting";
    readonly leaseToken: string;
    readonly meetingId: string;
    readonly subjectId: string;
  }): Promise<void>;
  /** Releases only a provider-proven zero-audio greeting attempt. */
  releaseGreetingAttempt?(input: {
    readonly evidence: "busy" | "unplayed";
    readonly kind: "greeting";
    readonly leaseToken: string;
    readonly meetingId: string;
    readonly subjectId: string;
  }): Promise<void>;
  reserve(input: {
    readonly kind: "farewell" | "greeting";
    readonly leaseSeconds: number;
    readonly meetingId: string;
    readonly subjectId: string;
  }): Promise<LiveConversationOneShotReceiptReservation>;
  /** Greeting-only terminal transition. Farewell completion semantics are unchanged. */
  settleGreeting?(input: {
    readonly kind: "greeting";
    readonly leaseToken: string;
    readonly meetingId: string;
    readonly outcome: "played" | "suppressed";
    readonly reason?: "ambiguous" | "stale";
    readonly subjectId: string;
  }): Promise<void>;
}

export type LiveFarewellTurn = ConversationFarewellTurn;
export type LiveFarewellClassificationInput = ConversationFarewellClassificationInput;

interface LiveFarewellConfiguration {
  readonly classifier?: ConversationFarewellClassifier;
  readonly cues: ConversationFarewellCueRegistry;
  readonly participantNames: Readonly<Record<string, string>>;
}

export interface LiveConversationConfiguration {
  readonly coordinator: LiveConversationCoordinator;
  readonly farewells?: LiveFarewellConfiguration;
  readonly greetings?: LiveParticipantGreetingConfiguration;
  readonly locale: string;
  readonly nowMilliseconds: () => number;
  readonly oneShotReceipts?: LiveConversationOneShotReceiptPort;
  readonly systemPrompt: string;
  readonly voiceProfileId: string;
}
