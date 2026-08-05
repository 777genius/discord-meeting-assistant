import type {
  LiveGenerationTelemetry,
  LiveGenerationTokenCount,
  LiveMeetingRefresher,
  LiveRuntimeClock,
  LiveRuntimeLogger,
} from "./contracts.js";

const refreshIntervalMs = 5_000;
const initialSummaryGenerationBackoffMs = 30_000;
const maximumSummaryGenerationBackoffMs = 300_000;

export interface LiveSummarySchedulerDependencies {
  readonly clock: LiveRuntimeClock;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly refreshMeeting: LiveMeetingRefresher;
}

export interface StartLiveSummaryGeneration {
  readonly isFinalizing: () => boolean;
  readonly nowMs: number;
  readonly requestProjection: () => void;
}

/** Runs the single-flight incremental summary cadence independently of rendering. */
export class LiveSummaryScheduler {
  private failureCount = 0;
  private generationPromise: Promise<void> | null = null;
  private nextRefreshAtMs: number;
  private permanentGenerationBase: string | null = null;
  private retryAtMs = 0;

  public constructor(
    private readonly dependencies: LiveSummarySchedulerDependencies,
  ) {
    this.nextRefreshAtMs = dependencies.clock.nowMilliseconds() + refreshIntervalMs;
  }

  public get dueAtMilliseconds(): number {
    return this.nextRefreshAtMs;
  }

  public isDue(nowMs: number): boolean {
    return nowMs >= this.nextRefreshAtMs;
  }

  public reschedule(previousDueAtMs: number, nowMs: number): void {
    const scheduled = previousDueAtMs + refreshIntervalMs;
    this.nextRefreshAtMs = scheduled > nowMs ? scheduled : nowMs + refreshIntervalMs;
  }

  public start(input: StartLiveSummaryGeneration): void {
    if (!this.canStart(input)) {
      return;
    }
    const generation = this.generate(input)
      .catch((error: unknown) => {
        this.deferFailure("UNEXPECTED_LIVE_GENERATION_FAILURE", true);
        this.dependencies.logger.warn("Incremental meeting summary refresh failed", {
          errorCode: "UNEXPECTED_LIVE_GENERATION_FAILURE",
          errorName: error instanceof Error ? error.name : "UnknownError",
          meetingId: this.dependencies.meetingId,
          retryable: true,
        });
      })
      .finally(() => {
        if (this.generationPromise === generation) {
          this.generationPromise = null;
        }
      });
    this.generationPromise = generation;
  }

  public reconcileEvidenceBase(generationBase: string | undefined): void {
    if (
      this.permanentGenerationBase === null ||
      generationBase === undefined ||
      generationBase === this.permanentGenerationBase
    ) {
      return;
    }
    this.failureCount = 0;
    this.retryAtMs = 0;
    this.permanentGenerationBase = null;
    this.dependencies.logger.info(
      "Incremental meeting summary fence cleared for new evidence",
      { meetingId: this.dependencies.meetingId },
    );
  }

  public async settle(): Promise<void> {
    await this.generationPromise?.catch(() => {});
  }

  private canStart(input: StartLiveSummaryGeneration): boolean {
    return (
      !input.isFinalizing() &&
      this.generationPromise === null &&
      this.permanentGenerationBase === null &&
      input.nowMs >= this.retryAtMs
    );
  }

  private async generate(input: StartLiveSummaryGeneration): Promise<void> {
    const startedAtMs = this.dependencies.clock.monotonicMilliseconds();
    const result = await this.dependencies.refreshMeeting.execute({
      captions: [],
      meetingId: this.dependencies.meetingId,
      nowMs: input.nowMs,
      projection: "skip",
      projectionRequested: false,
    });
    if (result.status === "not-found") {
      throw new Error("Live meeting disappeared before summary generation");
    }
    this.handleGenerationResult(result, input);
    this.logGenerationTelemetry(result.generationTelemetry);
    this.logGenerationUsage(result.generated, result.generationTelemetry, result.generationUsage);
    this.dependencies.logger.info("Incremental meeting summary refresh completed", {
      durationMs: Math.max(
        0,
        this.dependencies.clock.monotonicMilliseconds() - startedAtMs,
      ),
      generated: result.generated,
      meetingId: this.dependencies.meetingId,
      stale: result.generationStale ?? false,
    });
  }

  private handleGenerationResult(
    result: Exclude<Awaited<ReturnType<LiveMeetingRefresher["execute"]>>, { readonly status: "not-found" }>,
    input: StartLiveSummaryGeneration,
  ): void {
    if (result.generationFailure !== undefined) {
      this.handleGenerationFailure(
        result.generationFailure.code,
        result.generationFailure.retryable,
        result.generationBase,
      );
      this.dependencies.logger.warn("Incremental meeting summary refresh failed", {
        errorCode: result.generationFailure.code,
        meetingId: this.dependencies.meetingId,
        retryable: result.generationFailure.retryable,
      });
      return;
    }
    if (result.generated) {
      this.failureCount = 0;
      this.retryAtMs = 0;
      if (!input.isFinalizing()) {
        input.requestProjection();
      }
      return;
    }
    if (result.generationStale === true) {
      this.dependencies.logger.info("Incremental meeting summary result was stale", {
        meetingId: this.dependencies.meetingId,
      });
    }
  }

  private handleGenerationFailure(
    errorCode: string,
    retryable: boolean,
    generationBase: string | undefined,
  ): void {
    if (retryable || generationBase === undefined) {
      this.deferFailure(errorCode, true);
      return;
    }
    this.failureCount = 0;
    this.retryAtMs = Number.POSITIVE_INFINITY;
    this.permanentGenerationBase = generationBase;
    this.dependencies.logger.info("Incremental meeting summary permanently fenced", {
      errorCode,
      meetingId: this.dependencies.meetingId,
    });
  }

  private deferFailure(errorCode: string, retryable: boolean): void {
    this.failureCount += 1;
    const exponent = Math.min(this.failureCount - 1, 4);
    const delayMs = Math.min(
      initialSummaryGenerationBackoffMs * 2 ** exponent,
      maximumSummaryGenerationBackoffMs,
    );
    this.retryAtMs = this.dependencies.clock.nowMilliseconds() + delayMs;
    this.dependencies.logger.info("Incremental meeting summary retry deferred", {
      delayMs,
      errorCode,
      failureCount: this.failureCount,
      meetingId: this.dependencies.meetingId,
      retryable,
    });
  }

  private logGenerationTelemetry(
    telemetry: LiveGenerationTelemetry | undefined,
  ): void {
    if (telemetry === undefined) {
      return;
    }
    this.dependencies.logger.info(
      "Incremental meeting summary telemetry recorded",
      generationTelemetryLogFields(this.dependencies.meetingId, telemetry),
    );
  }

  private logGenerationUsage(
    generated: boolean,
    telemetry: LiveGenerationTelemetry | undefined,
    usage: {
      readonly apiEquivalentCostUsd: number | null;
      readonly cachedInputTokens: number;
      readonly inputTokens: number;
      readonly model: string;
      readonly outputTokens: number;
      readonly priceCard: string;
      readonly totalTokens: number;
    } | undefined,
  ): void {
    if (usage !== undefined) {
      this.dependencies.logger.info("Incremental meeting summary usage measured", {
        apiEquivalentCostUsd: usage.apiEquivalentCostUsd,
        cachedInputTokens: usage.cachedInputTokens,
        inputTokens: usage.inputTokens,
        meetingId: this.dependencies.meetingId,
        model: usage.model,
        outputTokens: usage.outputTokens,
        priceCard: usage.priceCard,
        totalTokens: usage.totalTokens,
      });
      return;
    }
    if (generated && telemetry === undefined) {
      this.dependencies.logger.warn(
        "Incremental meeting summary usage telemetry is missing",
        { meetingId: this.dependencies.meetingId },
      );
    }
  }
}

function generationTelemetryLogFields(
  meetingId: string,
  telemetry: LiveGenerationTelemetry,
): Readonly<Record<string, unknown>> {
  return {
    cacheWriteInputTokens: tokenLogValue(telemetry.cacheWriteInputTokens),
    cachedInputTokens: tokenLogValue(telemetry.cachedInputTokens),
    ...(telemetry.cost === undefined
      ? {}
      : {
          ...(telemetry.cost.exactUsd === undefined
            ? {}
            : { exactCostUsd: telemetry.cost.exactUsd }),
          maximumCostUsd: telemetry.cost.maximumUsd,
          minimumCostUsd: telemetry.cost.minimumUsd,
          priceCardId: telemetry.cost.priceCardId,
          priceCardSource: telemetry.cost.priceCardSource,
        }),
    inputTokens: tokenLogValue(telemetry.inputTokens),
    meetingId,
    model: telemetry.model,
    outputTokens: tokenLogValue(telemetry.outputTokens),
    reasoningOutputTokens: tokenLogValue(telemetry.reasoningOutputTokens),
    runId: telemetry.runId,
    source: telemetry.source,
    totalTokens: tokenLogValue(telemetry.totalTokens),
  };
}

function tokenLogValue(
  token: LiveGenerationTokenCount,
): Readonly<Record<string, unknown>> {
  if (token.availability === "unavailable") {
    return { availability: "unavailable" };
  }
  if (token.availability === "measured") {
    return { availability: "measured", value: token.value };
  }
  return {
    availability: "derived",
    derivedFrom: token.derivedFrom,
    value: token.value,
  };
}
