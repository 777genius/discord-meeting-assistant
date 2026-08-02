import type {
  FinalTranscriptionPort,
  FinalTranscriptionRequest,
  GeneratedSummary,
  GeneratedTranscript,
  PortResult,
  PublicationReceiptSnapshot,
  SummaryGenerationPort,
  SummaryGenerationRequest,
  SummaryPublicationPort,
  SummaryPublicationRequest,
} from "@discord-meeting/meeting-core";
import type {
  Logger,
  Metrics,
  ProcessingStage,
  StageOutcome,
} from "@discord-meeting/observability-adapter";

type PublicationResult = Pick<PublicationReceiptSnapshot, "externalPublicationId">;
type MonotonicClock = () => number;

class ProcessingStageTimer {
  public constructor(
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly nowMilliseconds: MonotonicClock,
  ) {}

  public async measure<Value>(
    stage: ProcessingStage,
    meetingId: string,
    operation: () => Promise<PortResult<Value>>,
  ): Promise<PortResult<Value>> {
    const startedAt = this.nowMilliseconds();
    try {
      const result = await operation();
      const outcome: StageOutcome = result.ok
        ? "succeeded"
        : result.failure.retryable
          ? "retryable-failure"
          : "terminal-failure";
      this.record(stage, meetingId, outcome, startedAt);
      return result;
    } catch (error: unknown) {
      this.record(stage, meetingId, "retryable-failure", startedAt);
      throw error;
    }
  }

  private record(
    stage: ProcessingStage,
    meetingId: string,
    outcome: StageOutcome,
    startedAt: number,
  ): void {
    const durationSeconds = Math.max(
      0,
      (this.nowMilliseconds() - startedAt) / 1_000,
    );
    this.metrics.observeStage(stage, outcome, durationSeconds);
    this.logger.info("Meeting processing stage completed", {
      durationMilliseconds: Math.round(durationSeconds * 1_000),
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
    metrics: Metrics,
    logger: Logger,
    nowMilliseconds: MonotonicClock,
  ) {
    this.timer = new ProcessingStageTimer(metrics, logger, nowMilliseconds);
  }

  public transcribe(
    request: FinalTranscriptionRequest,
  ): Promise<PortResult<GeneratedTranscript>> {
    return this.timer.measure(
      "transcription",
      request.meetingId,
      async () => this.delegate.transcribe(request),
    );
  }
}

export class InstrumentedSummaryGenerationPort implements SummaryGenerationPort {
  private readonly timer: ProcessingStageTimer;

  public constructor(
    private readonly delegate: SummaryGenerationPort,
    metrics: Metrics,
    logger: Logger,
    nowMilliseconds: MonotonicClock,
  ) {
    this.timer = new ProcessingStageTimer(metrics, logger, nowMilliseconds);
  }

  public generate(
    request: SummaryGenerationRequest,
  ): Promise<PortResult<GeneratedSummary>> {
    return this.timer.measure(
      "summary",
      request.meetingId,
      async () => this.delegate.generate(request),
    );
  }
}

export class InstrumentedSummaryPublicationPort implements SummaryPublicationPort {
  private readonly timer: ProcessingStageTimer;

  public constructor(
    private readonly delegate: SummaryPublicationPort,
    metrics: Metrics,
    logger: Logger,
    nowMilliseconds: MonotonicClock,
  ) {
    this.timer = new ProcessingStageTimer(metrics, logger, nowMilliseconds);
  }

  public publish(
    request: SummaryPublicationRequest,
  ): Promise<PortResult<PublicationResult>> {
    return this.timer.measure(
      "publication",
      request.meetingId,
      async () => this.delegate.publish(request),
    );
  }
}
