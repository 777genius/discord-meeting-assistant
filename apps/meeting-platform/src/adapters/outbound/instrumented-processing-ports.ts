import {
  type FinalTranscriptionPort,
  type FinalTranscriptionRequest,
  type GeneratedTranscript,
} from "@discord-meeting/meeting-core/transcription";
import {
  type GeneratedSummary,
  type SummaryGenerationPort,
  type SummaryGenerationRequest,
} from "@discord-meeting/meeting-core/meeting-intelligence";
import {
  type PublicationReceiptSnapshot,
  type SummaryPublicationPort,
  type SummaryPublicationRequest,
} from "@discord-meeting/meeting-core/publishing";
import type {
  Logger,
  ProcessingStageMetrics,
  ProcessingStage,
  StageOutcome,
} from "@discord-meeting/observability-adapter";

type PublicationResult = Pick<PublicationReceiptSnapshot, "externalPublicationId">;
type ProcessingPortResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | {
      readonly failure: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
      readonly ok: false;
    };
type MonotonicClock = () => number;
type StageLogDetails = Readonly<Record<string, unknown>>;
type EvidenceDetails = Readonly<{
  evidenceCharacterCount: number;
  evidenceSpeakerCount: number;
  evidenceSpeechSpanMs?: number;
  evidenceTimelineEndMs?: number;
  evidenceTimelineStartMs?: number;
  evidenceTurnCount: number;
}>;

const safeErrorNamePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

class ProcessingStageTimer {
  public constructor(
    private readonly metrics: ProcessingStageMetrics,
    private readonly logger: Logger,
    private readonly nowMilliseconds: MonotonicClock,
  ) {}

  public async measure<Value>(
    stage: ProcessingStage,
    meetingId: string,
    operation: () => Promise<ProcessingPortResult<Value>>,
    detailsForResult: (
      result: ProcessingPortResult<Value>,
      durationMilliseconds: number,
    ) => StageLogDetails,
  ): Promise<ProcessingPortResult<Value>> {
    const startedAt = this.nowMilliseconds();
    try {
      const result = await operation();
      const outcome: StageOutcome = result.ok
        ? "succeeded"
        : result.failure.retryable
          ? "retryable-failure"
          : "terminal-failure";
      this.record(stage, meetingId, outcome, startedAt, (durationMilliseconds) =>
        detailsForResult(result, durationMilliseconds),
      );
      return result;
    } catch (error: unknown) {
      this.record(
        stage,
        meetingId,
        "retryable-failure",
        startedAt,
        () => ({ errorName: errorName(error) }),
      );
      throw error;
    }
  }

  private record(
    stage: ProcessingStage,
    meetingId: string,
    outcome: StageOutcome,
    startedAt: number,
    details: (durationMilliseconds: number) => StageLogDetails,
  ): void {
    const durationSeconds = Math.max(
      0,
      (this.nowMilliseconds() - startedAt) / 1_000,
    );
    const durationMilliseconds = Math.round(durationSeconds * 1_000);
    this.metrics.observeStage(stage, outcome, durationSeconds);
    this.logger.info("Meeting processing stage completed", {
      ...details(durationMilliseconds),
      durationMilliseconds,
      meetingId,
      outcome,
      stage,
    });
  }
}

export class InstrumentedFinalTranscriptionPort implements FinalTranscriptionPort {
  private readonly timer: ProcessingStageTimer;

  public constructor(
    private readonly delegate: FinalTranscriptionPort,
    metrics: ProcessingStageMetrics,
    logger: Logger,
    nowMilliseconds: MonotonicClock,
  ) {
    this.timer = new ProcessingStageTimer(metrics, logger, nowMilliseconds);
  }

  public transcribe(
    request: FinalTranscriptionRequest,
  ): Promise<ProcessingPortResult<GeneratedTranscript>> {
    return this.timer.measure(
      "transcription",
      request.meetingId,
      async () => this.delegate.transcribe(request),
      (result, durationMilliseconds) =>
        transcriptionDetails(request, result, durationMilliseconds),
    );
  }
}

export class InstrumentedSummaryGenerationPort implements SummaryGenerationPort {
  private readonly timer: ProcessingStageTimer;

  public constructor(
    private readonly delegate: SummaryGenerationPort,
    metrics: ProcessingStageMetrics,
    logger: Logger,
    nowMilliseconds: MonotonicClock,
  ) {
    this.timer = new ProcessingStageTimer(metrics, logger, nowMilliseconds);
  }

  public generate(
    request: SummaryGenerationRequest,
  ): Promise<ProcessingPortResult<GeneratedSummary>> {
    return this.timer.measure(
      "summary",
      request.meetingId,
      async () => this.delegate.generate(request),
      (result) => summaryDetails(request, result),
    );
  }
}

export class InstrumentedSummaryPublicationPort implements SummaryPublicationPort {
  private readonly timer: ProcessingStageTimer;

  public constructor(
    private readonly delegate: SummaryPublicationPort,
    metrics: ProcessingStageMetrics,
    logger: Logger,
    nowMilliseconds: MonotonicClock,
  ) {
    this.timer = new ProcessingStageTimer(metrics, logger, nowMilliseconds);
  }

  public publish(
    request: SummaryPublicationRequest,
  ): Promise<ProcessingPortResult<PublicationResult>> {
    return this.timer.measure(
      "publication",
      request.meetingId,
      async () => this.delegate.publish(request),
      failureDetails,
    );
  }
}

function transcriptionDetails(
  request: FinalTranscriptionRequest,
  result: ProcessingPortResult<GeneratedTranscript>,
  durationMilliseconds: number,
): StageLogDetails {
  const requestDetails = {
    speakerTrackCount: request.recording.speakerAudio.length,
  };
  if (!result.ok) {
    return { ...requestDetails, ...failureDetails(result) };
  }
  const evidence = evidenceDetails(result.value);

  return {
    ...requestDetails,
    ...evidence,
    ...processingRatio(evidence.evidenceSpeechSpanMs, durationMilliseconds),
  };
}

function summaryDetails(
  request: SummaryGenerationRequest,
  result: ProcessingPortResult<GeneratedSummary>,
): StageLogDetails {
  const evidence = evidenceDetails(request.transcript);
  if (!result.ok) {
    return { ...evidence, ...failureDetails(result) };
  }

  return {
    ...evidence,
    summaryActionCount: result.value.actionItems.length,
    summaryDecisionCount: result.value.decisions.length,
    summaryQuestionCount: result.value.openQuestions.length,
    summaryTopicCount: result.value.topics.length,
  };
}

function failureDetails<Value>(result: ProcessingPortResult<Value>): StageLogDetails {
  if (result.ok) {
    return {};
  }

  return {
    failureCode: result.failure.code,
    retryable: result.failure.retryable,
  };
}

function evidenceDetails(
  transcript: Pick<GeneratedTranscript, "turns">,
): EvidenceDetails {
  let evidenceCharacterCount = 0;
  let evidenceTimelineEndMs = Number.NEGATIVE_INFINITY;
  let evidenceTimelineStartMs = Number.POSITIVE_INFINITY;
  const speakerIds = new Set<string>();

  for (const turn of transcript.turns) {
    evidenceCharacterCount += turn.text.length;
    evidenceTimelineEndMs = Math.max(evidenceTimelineEndMs, turn.endMs);
    evidenceTimelineStartMs = Math.min(evidenceTimelineStartMs, turn.startMs);
    speakerIds.add(turn.speakerId);
  }

  const counts = {
    evidenceCharacterCount,
    evidenceSpeakerCount: speakerIds.size,
    evidenceTurnCount: transcript.turns.length,
  };
  if (transcript.turns.length === 0) {
    return counts;
  }

  const evidenceSpeechSpanMs = Math.max(
    0,
    evidenceTimelineEndMs - evidenceTimelineStartMs,
  );
  return {
    ...counts,
    evidenceSpeechSpanMs,
    evidenceTimelineEndMs,
    evidenceTimelineStartMs,
  };
}

function processingRatio(
  evidenceSpeechSpanMs: number | undefined,
  durationMilliseconds: number,
): StageLogDetails {
  if (evidenceSpeechSpanMs === undefined || evidenceSpeechSpanMs === 0) {
    return {};
  }

  // The ratio uses the min-to-max evidence timeline span, not summed turn
  // durations, so overlapping speakers are not counted twice.
  return {
    processingToEvidenceRatio: durationMilliseconds / evidenceSpeechSpanMs,
  };
}

function errorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return "UnknownError";
  }

  try {
    const name = error.name;
    return safeErrorNamePattern.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}
