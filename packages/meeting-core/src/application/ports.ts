import type {
  MeetingSnapshot,
  PublicationReceiptSnapshot,
  StageFailure,
} from "../domain/meeting.js";
import type {
  LiveGenerationTelemetrySnapshot,
  LiveGenerationUsageSnapshot,
} from "../domain/live-generation.js";
import type {
  LiveMeetingSnapshot,
  LiveMeetingStatus,
} from "../domain/live-meeting.js";
import type { LiveSummaryDraftSnapshot } from "../domain/live-summary.js";
import type { RecordingArtifactSnapshot } from "../domain/recording.js";
import type {
  EvidenceBackedSummarySnapshot,
  SummaryActionItemSnapshot,
  SummaryDecisionSnapshot,
  SummaryOpenQuestionSnapshot,
  SummaryTopicSnapshot,
} from "../domain/summary.js";
import type {
  FinalTranscriptSnapshot,
  TranscriptTurnSnapshot,
} from "../domain/transcript.js";

export type PortResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly failure: StageFailure; readonly ok: false };

export interface MeetingRepository {
  findById(meetingId: string): Promise<MeetingSnapshot | null>;

  save(snapshot: MeetingSnapshot, expectedRevision: number): Promise<void>;
}

/** Durable work item whose processing receipt is independent of Redis. */
export interface PostCallWorkItem {
  readonly meetingId: string;
  readonly schemaVersion: 1;
}

/**
 * Delivery remains recoverable until `markPostCallProcessed` is called after a
 * durable terminal receipt from the worker. Queue submission is only an
 * observation and cannot remove an item from this outbox.
 */
export interface PostCallOutbox {
  listRecoverablePostCall(limit?: number): Promise<readonly PostCallWorkItem[]>;

  markPostCallEnqueued(meetingId: string): Promise<void>;

  markPostCallProcessed(meetingId: string): Promise<void>;
}

/** Provider-neutral terminal failure evidence for the post-call worker. */
export interface PostCallDeadLetterRecord {
  readonly attemptsMade: number;
  readonly failureCode: string;
  readonly meetingId: string | null;
  readonly retryable: boolean;
  readonly schemaVersion: 1;
  readonly sourceJobRef: string;
}

export type PostCallDeadLetterAppendResult = "recorded" | "reused";

export interface PostCallDeadLetterEvidence extends PostCallDeadLetterRecord {
  readonly recordedAt: string;
}

/** Independent of a Redis DLQ so a terminal failure remains health-readable. */
export interface PostCallDeadLetterLedger {
  recordPostCallDeadLetter(
    record: PostCallDeadLetterRecord,
  ): Promise<PostCallDeadLetterAppendResult>;

  listPostCallDeadLetters(limit?: number): Promise<readonly PostCallDeadLetterEvidence[]>;
}

/** Atomically records terminal evidence and removes linked work from recovery. */
export interface PostCallTerminalFailureSettlement {
  settlePostCallFailure(
    record: PostCallDeadLetterRecord,
  ): Promise<PostCallDeadLetterAppendResult>;
}

/** CAS-owned lifecycle, summary and projection state only. */
export interface LiveMeetingStateRepository {
  findById(meetingId: string): Promise<LiveMeetingSnapshot | null>;

  save(snapshot: LiveMeetingSnapshot, expectedRevision: number | null): Promise<void>;
}

export type LiveAppendResult = "appended" | "not-found" | "reused";

/** A finalized turn plus its derived incremental-summary coverage marker. */
export interface LiveFinalizedTurn {
  readonly isSummarized: boolean;
  readonly turn: TranscriptTurnSnapshot;
}

/**
 * Append-only timeline storage. `turnId` is the stable idempotency key and a
 * replay with different content must fail rather than overwrite evidence. A
 * new turn advances the compact meeting revision exactly once; a replay does
 * not, so projections can observe newly finalized evidence.
 */
export interface LiveMeetingTimelineRepository {
  appendFinalizedTurn(
    meetingId: string,
    turn: TranscriptTurnSnapshot,
  ): Promise<LiveAppendResult>;

  listFinalizedTurns(meetingId: string): Promise<readonly LiveFinalizedTurn[]>;
}

/** An aggregate snapshot and its append-only timeline from one read boundary. */
export interface LiveMeetingSnapshotAndTimeline {
  readonly snapshot: LiveMeetingSnapshot;
  readonly timeline: readonly LiveFinalizedTurn[];
}

/**
 * A consumer that needs both surfaces must use this port rather than compose
 * two unrelated reads. PostgreSQL provides it through a repeatable-read
 * transaction; in-memory adapters can provide an equivalent atomic snapshot.
 */
export interface LiveMeetingSnapshotAndTimelineReader {
  readSnapshotAndTimeline(
    meetingId: string,
  ): Promise<LiveMeetingSnapshotAndTimeline | null>;
}

/**
 * Append-only operational generation records. `runId` is the stable
 * idempotency key. These writes never advance the business aggregate revision.
 */
export interface LiveMeetingGenerationLedger {
  appendGenerationTelemetry(
    meetingId: string,
    telemetry: LiveGenerationTelemetrySnapshot,
  ): Promise<LiveAppendResult>;

  appendGenerationUsage(
    meetingId: string,
    usage: LiveGenerationUsageSnapshot,
  ): Promise<LiveAppendResult>;
}

export interface CommitLiveMeetingSummaryInput {
  /** Compact state after domain validation. */
  readonly snapshot: LiveMeetingSnapshot;
  readonly expectedRevision: number;
  /** Only newly covered turns are recorded; previous coverage is immutable. */
  readonly newlySummarizedTurnIds: readonly string[];
  readonly telemetry?: LiveGenerationTelemetrySnapshot;
  readonly usage?: LiveGenerationUsageSnapshot;
}

/** Atomically commits summary state, new coverage, and generation records. */
export interface LiveMeetingSummaryRepository {
  commitSummary(input: CommitLiveMeetingSummaryInput): Promise<void>;
}

/** Convenience composition for processes that own the whole live workflow. */
export interface LiveMeetingRepository extends
  LiveMeetingGenerationLedger,
  LiveMeetingStateRepository,
  LiveMeetingSummaryRepository,
  LiveMeetingTimelineRepository {}

export interface LiveCaptionSnapshot {
  readonly endMs: number;
  readonly isFinal: boolean;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
}

export type ConversationCancellationReason =
  | "barge-in"
  | "meeting-ended"
  | "playback-failed"
  | "runtime-shutdown"
  | "superseded";

export interface ConversationStartRequest {
  readonly idempotencyKey: string;
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

/**
 * Presentation lifecycle for the mutable live projection. It is deliberately
 * separate from the aggregate status: provider final turns can still be
 * appended while the user is told that the visible draft is finalizing.
 */
export type LiveMeetingProjectionPhase = "live" | "finalizing";

export interface IncrementalSummaryGenerationRequest {
  readonly idempotencyKey: string;
  readonly knownSpeakerIds: readonly string[];
  readonly knownTurnIds: readonly string[];
  readonly meetingId: string;
  readonly newTurns: readonly TranscriptTurnSnapshot[];
  readonly previousSummary: LiveSummaryDraftSnapshot | null;
  readonly recentContextTurns: readonly TranscriptTurnSnapshot[];
  readonly revision: number;
  readonly throughTurnCount: number;
}

export interface GeneratedIncrementalSummary {
  readonly summary: LiveSummaryDraftSnapshot;
  readonly telemetry?: LiveGenerationTelemetrySnapshot;
  readonly usage?: LiveGenerationUsageSnapshot;
}

export type IncrementalSummaryGenerationResult =
  | { readonly ok: true; readonly value: GeneratedIncrementalSummary }
  | {
      readonly failure: StageFailure;
      readonly ok: false;
      readonly telemetry?: LiveGenerationTelemetrySnapshot;
      readonly usage?: LiveGenerationUsageSnapshot;
    };

export interface IncrementalSummaryGenerationPort {
  generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<IncrementalSummaryGenerationResult>;
}

export interface LiveMeetingProjectionRequest {
  readonly captions: readonly LiveCaptionSnapshot[];
  readonly currentExternalPublicationId: string | null;
  readonly elapsedMs: number;
  readonly idempotencyKey: string;
  readonly meetingId: string;
  readonly phase: LiveMeetingProjectionPhase;
  readonly publicationTargetId: string;
  readonly revision: number;
  readonly status: LiveMeetingStatus;
  readonly summary: LiveSummaryDraftSnapshot | null;
  readonly updatedAtMs: number;
}

export interface LiveMeetingProjectionPort {
  publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>>;
}

export interface FinalTranscriptionRequest {
  readonly idempotencyKey: string;
  readonly meetingId: string;
  readonly recording: RecordingArtifactSnapshot;
  /** Cancels only this in-flight attempt; retries reuse the same identity. */
  readonly signal?: AbortSignal;
}

export interface GeneratedTranscript {
  readonly transcriptId: string;
  readonly turns: readonly TranscriptTurnSnapshot[];
  readonly version: number;
}

export interface FinalTranscriptionPort {
  transcribe(
    request: FinalTranscriptionRequest,
  ): Promise<PortResult<GeneratedTranscript>>;
}

export interface SummaryGenerationRequest {
  readonly idempotencyKey: string;
  readonly meetingId: string;
  readonly transcript: FinalTranscriptSnapshot;
}

export interface GeneratedSummary {
  readonly actionItems: readonly SummaryActionItemSnapshot[];
  readonly decisions: readonly SummaryDecisionSnapshot[];
  readonly openQuestions: readonly SummaryOpenQuestionSnapshot[];
  readonly overview: string;
  readonly summaryId: string;
  readonly title: string;
  readonly topics: readonly SummaryTopicSnapshot[];
  readonly version: number;
}

export interface SummaryGenerationPort {
  generate(request: SummaryGenerationRequest): Promise<PortResult<GeneratedSummary>>;
}

export interface SummaryPublicationRequest {
  /**
   * A durable physical receipt from the settled live projection, when one
   * exists. Publication adapters may use it to preserve the one visible
   * projection even if its human-facing marker was changed externally.
   */
  readonly currentExternalPublicationId?: string | null;
  readonly idempotencyKey: string;
  readonly meetingId: string;
  readonly publicationTargetId: string;
  readonly summary: EvidenceBackedSummarySnapshot;
  /** Authoritative evidence timeline used by publication adapters. */
  readonly transcript: FinalTranscriptSnapshot;
}

export interface SummaryPublicationPort {
  publish(
    request: SummaryPublicationRequest,
  ): Promise<PortResult<Pick<PublicationReceiptSnapshot, "externalPublicationId">>>;
}

export type SummaryPublicationEffectReservation =
  | { readonly status: "acquired" | "pending" }
  | { readonly externalReceipt: string; readonly status: "completed" };

/** Durable fence around a non-transactional external publication create. */
export interface SummaryPublicationEffectLedger {
  reserveSummaryPublicationEffect(input: {
    readonly projectionKey: string;
    readonly publicationTargetId: string;
  }): Promise<SummaryPublicationEffectReservation>;

  completeSummaryPublicationEffect(input: {
    readonly externalReceipt: string;
    readonly projectionKey: string;
    readonly publicationTargetId: string;
  }): Promise<void>;

  replaceSummaryPublicationEffect(input: {
    readonly expectedExternalReceipt: string;
    readonly externalReceipt: string;
    readonly projectionKey: string;
    readonly publicationTargetId: string;
  }): Promise<void>;
}
