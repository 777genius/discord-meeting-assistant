import type {
  ConversationFarewellClassificationInput,
  ConversationFarewellClassifier,
  ConversationFarewellCueRegistry,
  ConversationFarewellTurn,
} from "@discord-meeting/meeting-core/conversation";

/**
 * Consumer-owned vocabulary for the derived live-meeting runtime. Inbound and
 * outbound adapters map their provider DTOs to these small shapes at the
 * platform boundary.
 */

export interface LiveRuntimeLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface LiveRuntimeClock {
  monotonicMilliseconds(): number;
  nowMilliseconds(): number;
}

export interface LiveRuntimeTimerHandle {
  unref?(): unknown;
}

export interface LiveRuntimeTimer {
  cancel(handle: LiveRuntimeTimerHandle): void;
  repeat(
    intervalMs: number,
    callback: () => void,
  ): LiveRuntimeTimerHandle;
  schedule(delayMs: number, callback: () => void): LiveRuntimeTimerHandle;
}

interface LiveMeetingEventBase {
  readonly occurredAt: string;
  readonly recordingId: string;
}

interface DeferredLivePublicationTarget {
  resolve(): Promise<string | null>;
}

export interface LiveMeetingStartedEvent extends LiveMeetingEventBase {
  readonly participantIds: readonly string[];
  readonly publicationTarget: DeferredLivePublicationTarget;
  readonly type: "meeting.started";
}

export interface LiveMeetingParticipantEvent extends LiveMeetingEventBase {
  readonly participantId: string;
  readonly type: "participant.joined" | "participant.left";
}

interface LiveMeetingStoppedEvent extends LiveMeetingEventBase {
  readonly type: "meeting.ended" | "meeting.aborted";
}

interface LiveMeetingIgnoredEvent extends LiveMeetingEventBase {
  readonly type:
    | "meeting.connection_lost"
    | "meeting.connection_recovered"
    | "recording.artifact_ready"
    | "recording.authoritative_ready";
}

export type LiveMeetingLifecycleEvent =
  | LiveMeetingIgnoredEvent
  | LiveMeetingParticipantEvent
  | LiveMeetingStartedEvent
  | LiveMeetingStoppedEvent;

export interface LiveVoicePacket {
  readonly mediaTimestamp: number;
  readonly payloadBase64: string;
  readonly receivedAtMs: number;
  readonly recordingId: string;
  readonly relativeTimeMs: number;
  readonly sequenceNumber: number;
  readonly speakerId: string;
}

export interface LiveVoicePacketBatch {
  readonly format: {
    readonly channelCount: 1;
    readonly codec: "opus";
    readonly sampleRateHz: 48_000;
  };
  readonly packets: readonly LiveVoicePacket[];
}

export interface LiveTranscriptionEvent {
  readonly endMs: number;
  readonly isFinal: boolean;
  readonly meetingId: string;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
}

interface LiveTranscriptionPacket {
  readonly durationSamples48Khz: number;
  readonly opus: Uint8Array;
  readonly packetId: string;
  readonly relativeTimeMs: number;
}

export interface LiveTranscriptionSession {
  finalize(): Promise<void>;
  sendPacket(packet: LiveTranscriptionPacket): Promise<"accepted" | "reused">;
  terminate(): void;
}

interface OpenLiveTranscriptionSession {
  readonly idempotencyKey: string;
  readonly meetingId: string;
  readonly onTranscript: (event: LiveTranscriptionEvent) => void;
  readonly signal?: AbortSignal;
  readonly speakerId: string;
}

export interface LiveTranscriptionPort {
  openSession(
    request: OpenLiveTranscriptionSession,
  ): Promise<LiveTranscriptionSession>;
}

export interface LivePacketInspector {
  durationSamples48Khz(opus: Uint8Array): number;
}

export interface LiveCaptionSnapshot {
  readonly endMs: number;
  readonly isFinal: boolean;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
}

export interface LiveCaptionSignature {
  calculate(captions: readonly LiveCaptionSnapshot[]): string;
}

export interface LiveTranscriptTurn {
  readonly endMs: number;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
  readonly turnId: string;
}

interface LiveMeetingStartPort {
  execute(input: {
    readonly meetingId: string;
    readonly publicationTargetId: string;
    readonly startedAtMs: number;
  }): Promise<{
    readonly finalizedTurns: readonly LiveTranscriptTurn[];
    readonly lifecycleStatus: "active" | "ended";
    readonly status: "reused" | "started";
  }>;
}

interface LiveTranscriptAppender {
  execute(
    meetingId: string,
    turn: LiveTranscriptTurn,
  ): Promise<"appended" | "not-found" | "reused">;
}

interface LiveMeetingFinisher {
  execute(
    meetingId: string,
    endedAtMs: number,
  ): Promise<"ended" | "not-found" | "reused">;
}

interface LiveStageFailure {
  readonly code: string;
  readonly retryable: boolean;
}

export interface LiveGenerationTokenCount {
  readonly availability: "derived" | "measured" | "unavailable";
  readonly derivedFrom?: readonly ["inputTokens", "outputTokens"];
  readonly value?: number;
}

export interface LiveGenerationTelemetry {
  readonly cacheWriteInputTokens: LiveGenerationTokenCount;
  readonly cachedInputTokens: LiveGenerationTokenCount;
  readonly cost?: {
    readonly exactUsd?: number;
    readonly maximumUsd: number;
    readonly minimumUsd: number;
    readonly priceCardId: string;
    readonly priceCardSource: string;
  };
  readonly inputTokens: LiveGenerationTokenCount;
  readonly model: string;
  readonly outputTokens: LiveGenerationTokenCount;
  readonly reasoningOutputTokens: LiveGenerationTokenCount;
  readonly runId: string;
  readonly source: string;
  readonly totalTokens: LiveGenerationTokenCount;
}

interface LiveGenerationUsage {
  readonly apiEquivalentCostUsd: number | null;
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly priceCard: string;
  readonly totalTokens: number;
}

interface LiveMeetingRefreshInput {
  readonly captions: readonly LiveCaptionSnapshot[];
  readonly meetingId: string;
  readonly nowMs: number;
  readonly projection?: "allow" | "skip";
  readonly projectionPhase?: "finalizing" | "live";
  readonly projectionRequested?: boolean;
  readonly summaryGeneration?: "cadence" | "skip";
}

export type LiveMeetingRefreshResult =
  | { readonly status: "not-found" }
  | {
      readonly generated: boolean;
      readonly generationBase?: string;
      readonly generationFailure?: LiveStageFailure;
      readonly generationStale?: boolean;
      readonly generationTelemetry?: LiveGenerationTelemetry;
      readonly generationUsage?: LiveGenerationUsage;
      readonly projected: boolean;
      readonly projectionFailure?: LiveStageFailure;
      readonly status: "refreshed";
    };

export interface LiveMeetingRefresher {
  execute(input: LiveMeetingRefreshInput): Promise<LiveMeetingRefreshResult>;
}

interface LiveConversationOutcome {
  readonly status:
    | "ignored"
    | "awaiting-prompt"
    | "active"
    | "queued"
    | "busy"
    | "reused";
}

interface LiveConversationTurnInput {
  readonly locale: string;
  readonly meetingId: string;
  readonly nowMs: number;
  readonly recordingId: string;
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
  readonly systemPrompt: string;
  readonly voiceProfileId: string;
}

export interface LivePacketFlowControl {
  readonly maximumConcurrentSessions?: number;
  readonly maximumQueuedPacketsGlobally?: number;
  readonly maximumQueuedPacketsPerSpeaker?: number;
  readonly packetBackpressureTimeoutMs?: number;
}

export interface LiveMeetingRuntimeDependencies {
  readonly appendTurn: LiveTranscriptAppender;
  readonly captionSignature?: LiveCaptionSignature;
  readonly clock?: LiveRuntimeClock;
  readonly conversation?: LiveConversationConfiguration;
  readonly finishMeeting: LiveMeetingFinisher;
  readonly logger: LiveRuntimeLogger;
  readonly packetFlowControl?: LivePacketFlowControl;
  readonly packetInspector?: LivePacketInspector;
  readonly refreshMeeting: LiveMeetingRefresher;
  readonly speakerIdleFinalizeMs?: number;
  readonly startMeeting: LiveMeetingStartPort;
  readonly timer?: LiveRuntimeTimer;
  readonly transcriber: LiveTranscriptionPort;
}
