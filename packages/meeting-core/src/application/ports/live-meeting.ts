import type {
  LiveGenerationTelemetrySnapshot,
  LiveGenerationUsageSnapshot,
} from "../../domain/live-generation.js";
import type {
  LiveMeetingSnapshot,
  LiveMeetingStatus,
} from "../../domain/live-meeting.js";
import type { LiveSummaryDraftSnapshot } from "../../domain/live-summary.js";
import type { StageFailure } from "../../domain/meeting.js";
import type { TranscriptTurnSnapshot } from "../../domain/transcript.js";
import type { PortResult } from "./shared.js";

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
