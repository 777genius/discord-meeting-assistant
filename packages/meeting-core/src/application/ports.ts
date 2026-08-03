import type {
  MeetingSnapshot,
  PublicationReceiptSnapshot,
  StageFailure,
} from "../domain/meeting.js";
import type {
  LiveGenerationTelemetrySnapshot,
  LiveGenerationUsageSnapshot,
  LiveMeetingSnapshot,
  LiveMeetingStatus,
  LiveSummaryDraftSnapshot,
} from "../domain/live-meeting.js";
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

export interface LiveMeetingRepository {
  findById(meetingId: string): Promise<LiveMeetingSnapshot | null>;

  save(snapshot: LiveMeetingSnapshot, expectedRevision: number | null): Promise<void>;
}

export interface LiveCaptionSnapshot {
  readonly endMs: number;
  readonly isFinal: boolean;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
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
