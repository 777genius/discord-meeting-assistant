import type {
  SummaryActionItemSnapshot,
  SummaryDecisionSnapshot,
  SummaryOpenQuestionSnapshot,
  SummaryTopicSnapshot,
} from "../../domain/summary.js";
import type { FinalTranscriptSnapshot } from "../../domain/transcript.js";
import type { PortResult } from "./shared.js";

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
