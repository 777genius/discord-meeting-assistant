import type {
  MeetingSnapshot,
  PublicationReceiptSnapshot,
  StageFailure,
} from "../domain/meeting.js";
import type { RecordingArtifactSnapshot } from "../domain/recording.js";
import type {
  EvidenceBackedSummarySnapshot,
  SummaryActionItemSnapshot,
  SummaryDecisionSnapshot,
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

export interface FinalTranscriptionRequest {
  readonly idempotencyKey: string;
  readonly meetingId: string;
  readonly recording: RecordingArtifactSnapshot;
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
  readonly openQuestions: readonly string[];
  readonly overview: string;
  readonly summaryId: string;
  readonly title: string;
  readonly version: number;
}

export interface SummaryGenerationPort {
  generate(request: SummaryGenerationRequest): Promise<PortResult<GeneratedSummary>>;
}

export interface SummaryPublicationRequest {
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
