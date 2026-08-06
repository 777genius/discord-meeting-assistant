import type {
  SummaryActionItemSnapshot,
  SummaryDecisionSnapshot,
  SummaryOpenQuestionSnapshot,
  SummaryTopicSnapshot,
} from "../../domain/summary.js";
import type { FinalTranscriptSnapshot } from "../../../transcription/index.js";

export interface SummaryGenerationFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type SummaryGenerationResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly failure: SummaryGenerationFailure; readonly ok: false };

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
  generate(request: SummaryGenerationRequest): Promise<SummaryGenerationResult<GeneratedSummary>>;
}
