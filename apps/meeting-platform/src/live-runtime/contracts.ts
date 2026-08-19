import type { LiveConversationConfiguration } from "./conversation-contracts.js";

export type {
  LiveConversationConfiguration,
  LiveConversationOneShotReceiptPort,
  LiveConversationOneShotReceiptReservation,
  LiveFarewellClassificationInput,
  LiveFarewellTurn,
  LiveParticipantGreetingProfile,
} from "./conversation-contracts.js";

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

interface LiveMemoryIdentity {
  readonly actors: readonly {
    readonly actorId: string;
    readonly kind: "automation" | "human" | "unknown";
  }[];
  readonly identityProvenance: {
    readonly actorObservationState: "consistent" | "conflicted";
    readonly actorSemanticsVersion: number;
    readonly producerCapabilityId: string;
    readonly producerRevision: string;
    readonly rosterState: "sealed" | "unsealed";
  };
  readonly lifecycleGeneration: 3;
  readonly roomId: string;
  readonly scopeId: string;
}

interface DeferredLivePublicationTarget {
  resolve(): Promise<string | null>;
}

export interface LiveMeetingStartedEvent extends LiveMeetingEventBase {
  readonly participantIds: readonly string[];
  readonly publicationTarget: DeferredLivePublicationTarget;
  readonly roomId: string;
  readonly memoryIdentity?: LiveMemoryIdentity;
  readonly type: "meeting.started";
}

export interface LiveMeetingParticipantEvent extends LiveMeetingEventBase {
  readonly memoryHumanObservation?: {
    readonly actorId: string;
    readonly producerRevision: string;
  };
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
    | "recording.artifact_ready";
}

interface LiveMeetingAuthoritativeReadyEvent extends LiveMeetingEventBase {
  readonly memoryIdentity?: LiveMemoryIdentity;
  readonly type: "recording.authoritative_ready";
}

export type LiveMeetingLifecycleEvent =
  | LiveMeetingIgnoredEvent
  | LiveMeetingAuthoritativeReadyEvent
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
  readonly finalizedMemory?: {
    finishMeeting(meetingId: string): Promise<void>;
    observeHuman(input: {
      readonly actorId: string;
      readonly meetingId: string;
      readonly producerRevision: string;
    }): Promise<"accepted" | "ineligible" | "replayed">;
    removeHuman(input: {
      readonly actorId: string;
      readonly meetingId: string;
      readonly producerRevision: string;
    }): Promise<"accepted" | "ineligible" | "replayed">;
    registerMeeting(input: {
      readonly actors: LiveMemoryIdentity["actors"];
      readonly identityProvenance: LiveMemoryIdentity["identityProvenance"];
      readonly lifecycleGeneration: 3;
      readonly meetingId: string;
      readonly roomId: string;
      readonly scopeId: string;
    }): Promise<"accepted" | "ineligible" | "replayed">;
    sealMeeting(input: {
      readonly actors: LiveMemoryIdentity["actors"];
      readonly identityProvenance: LiveMemoryIdentity["identityProvenance"];
      readonly lifecycleGeneration: 3;
      readonly meetingId: string;
      readonly roomId: string;
      readonly scopeId: string;
    }): Promise<"accepted" | "ineligible" | "replayed">;
    synchronizeMeeting(meetingId: string): Promise<void>;
  };
  readonly logger: LiveRuntimeLogger;
  readonly packetFlowControl?: LivePacketFlowControl;
  readonly packetInspector?: LivePacketInspector;
  readonly refreshMeeting: LiveMeetingRefresher;
  readonly speakerIdleFinalizeMs?: number;
  readonly startMeeting: LiveMeetingStartPort;
  readonly timer?: LiveRuntimeTimer;
  readonly transcriber: LiveTranscriptionPort;
}
