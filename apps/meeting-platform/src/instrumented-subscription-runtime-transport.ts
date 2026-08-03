import type {
  SubscriptionRuntimeAgentTaskRequest,
  SubscriptionRuntimeHealthResult,
  SubscriptionRuntimeTaskResult,
  SubscriptionRuntimeTelemetry,
  SubscriptionRuntimeTokenAvailability,
  SubscriptionRuntimeTransportPort,
  SubscriptionRuntimeUsage,
} from "@discord-meeting/subscription-runtime-adapter";
import type { Logger } from "@discord-meeting/observability-adapter";

type MonotonicClock = () => number;
type ProviderUnit =
  | {
      readonly availability: "derived";
      readonly derivedFrom: readonly ["inputTokens", "outputTokens"];
      readonly value: number;
    }
  | { readonly availability: "measured"; readonly value: number }
  | { readonly availability: "unavailable" };
type ProviderUnits = Readonly<{
  cacheWriteInput: ProviderUnit;
  cachedInput: ProviderUnit;
  input: ProviderUnit;
  output: ProviderUnit;
  reasoningOutput: ProviderUnit;
  total: ProviderUnit;
}>;
type UsageCompleteness = "complete" | "partial" | "unavailable";
type ProviderCost =
  | { readonly availability: "unavailable" }
  | {
      readonly availability: "bounded";
      readonly maximumUsd: number;
      readonly minimumUsd: number;
      readonly priceCardId: string;
      readonly priceCardSource: string;
    }
  | {
      readonly availability: "exact";
      readonly exactUsd: number;
      readonly maximumUsd: number;
      readonly minimumUsd: number;
      readonly priceCardId: string;
      readonly priceCardSource: string;
    };

const safeErrorNamePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

/**
 * Composition-only decorator that observes runtime calls without changing the
 * transport contract or letting logging affect the provider outcome.
 */
export class InstrumentedSubscriptionRuntimeTransport
  implements SubscriptionRuntimeTransportPort
{
  public constructor(
    private readonly delegate: SubscriptionRuntimeTransportPort,
    private readonly logger: Logger,
    private readonly nowMilliseconds: MonotonicClock,
  ) {}

  public checkHealth(): Promise<SubscriptionRuntimeHealthResult> {
    return this.delegate.checkHealth();
  }

  public async execute(
    request: SubscriptionRuntimeAgentTaskRequest,
  ): Promise<SubscriptionRuntimeTaskResult> {
    const startedAt = readClock(this.nowMilliseconds);
    try {
      const result = await this.delegate.execute(request);
      this.writeInfo(
        "Subscription runtime task completed",
        executionLogFields(
          request,
          result,
          durationMilliseconds(startedAt, readClock(this.nowMilliseconds)),
        ),
      );
      return result;
    } catch (error: unknown) {
      this.writeWarn(
        "Subscription runtime transport failed",
        exceptionLogFields(
          request,
          durationMilliseconds(startedAt, readClock(this.nowMilliseconds)),
          error,
        ),
      );
      throw error;
    }
  }

  private writeInfo(message: string, fields: Readonly<Record<string, unknown>>): void {
    try {
      this.logger.info(message, fields);
    } catch {
      // Telemetry must never make an otherwise valid provider result fail.
    }
  }

  private writeWarn(message: string, fields: Readonly<Record<string, unknown>>): void {
    try {
      this.logger.warn(message, fields);
    } catch {
      // Preserve the original transport exception when log delivery is broken.
    }
  }
}

function executionLogFields(
  request: SubscriptionRuntimeAgentTaskRequest,
  result: SubscriptionRuntimeTaskResult,
  durationMs: number | undefined,
): Readonly<Record<string, unknown>> {
  const resultDetails = {
    ...providerUsageDetails(
      result.status === "waiting_for_input" ? undefined : result.telemetry,
      result.status === "waiting_for_input" ? undefined : result.usage,
    ),
    ...(result.status === "failed"
      ? {
          failureCode: result.failure.code,
          retryable: result.failure.retryable,
        }
      : {}),
  };
  return {
    ...resultDetails,
    ...requestIdentity(request),
    ...(durationMs === undefined ? {} : { durationMs }),
    status: result.status,
  };
}

function exceptionLogFields(
  request: SubscriptionRuntimeAgentTaskRequest,
  durationMs: number | undefined,
  error: unknown,
): Readonly<Record<string, unknown>> {
  return {
    ...requestIdentity(request),
    ...(durationMs === undefined ? {} : { durationMs }),
    errorName: errorName(error),
    status: "exception",
  };
}

function requestIdentity(
  request: SubscriptionRuntimeAgentTaskRequest,
): Readonly<Record<string, unknown>> {
  const { summaryRevision, throughTurnCount } = request.context.metadata;
  const numericSummaryRevision = decimalMetadata(summaryRevision);
  const numericThroughTurnCount = decimalMetadata(throughTurnCount);
  return {
    meetingId: request.context.metadata.meetingId,
    purpose: request.context.purpose,
    model: request.task.controls.model,
    outputSchemaName: request.task.controls.outputSchemaName,
    policyVersion: request.context.metadata.policyVersion,
    reasoningEffort: request.task.controls.reasoningEffort,
    maxOutputUnits: request.task.controls.maxOutputTokens,
    requestCharacterCount: request.task.prompt.length,
    runId: request.runId,
    systemInstructionCharacterCount: request.task.systemPrompt.length,
    timeoutMs: request.timeoutMs,
    ...(numericThroughTurnCount === undefined
      ? {}
      : { throughTurnCount: numericThroughTurnCount }),
    ...(numericSummaryRevision === undefined
      ? {}
      : { summaryRevision: numericSummaryRevision }),
  };
}

function providerUsageDetails(
  telemetry: SubscriptionRuntimeTelemetry | undefined,
  usage: SubscriptionRuntimeUsage | undefined,
): Readonly<Record<string, unknown>> {
  return {
    providerCost: providerCost(telemetry?.cost),
    providerUnits: providerUnits(telemetry, usage),
    usageCompleteness: usageCompleteness(telemetry, usage),
  };
}

function providerUnits(
  telemetry: SubscriptionRuntimeTelemetry | undefined,
  usage: SubscriptionRuntimeUsage | undefined,
): ProviderUnits {
  if (usage !== undefined) {
    return {
      cacheWriteInput: measuredUnit(usage.cacheWriteInputTokens),
      cachedInput: measuredUnit(usage.cachedInputTokens),
      input: measuredUnit(usage.inputTokens),
      output: measuredUnit(usage.outputTokens),
      reasoningOutput: measuredUnit(usage.reasoningOutputTokens),
      total: measuredUnit(usage.totalTokens),
    };
  }
  if (telemetry !== undefined) {
    return {
      cacheWriteInput: providerUnit(telemetry.cacheWriteInputTokens),
      cachedInput: providerUnit(telemetry.cachedInputTokens),
      input: providerUnit(telemetry.inputTokens),
      output: providerUnit(telemetry.outputTokens),
      reasoningOutput: providerUnit(telemetry.reasoningOutputTokens),
      total: providerUnit(telemetry.totalTokens),
    };
  }
  return {
    cacheWriteInput: unavailableUnit(),
    cachedInput: unavailableUnit(),
    input: unavailableUnit(),
    output: unavailableUnit(),
    reasoningOutput: unavailableUnit(),
    total: unavailableUnit(),
  };
}

function providerUnit(value: SubscriptionRuntimeTokenAvailability): ProviderUnit {
  if (value.availability === "unavailable") {
    return unavailableUnit();
  }
  if (value.availability === "derived") {
    return {
      availability: "derived",
      derivedFrom: value.derivedFrom,
      value: value.value,
    };
  }
  return { availability: "measured", value: value.value };
}

function measuredUnit(value: number): ProviderUnit {
  return { availability: "measured", value };
}

function unavailableUnit(): ProviderUnit {
  return { availability: "unavailable" };
}

function usageCompleteness(
  telemetry: SubscriptionRuntimeTelemetry | undefined,
  usage: SubscriptionRuntimeUsage | undefined,
): UsageCompleteness {
  if (usage !== undefined) {
    return "complete";
  }
  return telemetry === undefined ? "unavailable" : "partial";
}

function providerCost(
  cost: SubscriptionRuntimeTelemetry["cost"],
): ProviderCost {
  if (cost === undefined) {
    return { availability: "unavailable" };
  }
  if (cost.exactUsd === undefined) {
    return {
      availability: "bounded",
      maximumUsd: cost.maximumUsd,
      minimumUsd: cost.minimumUsd,
      priceCardId: cost.priceCardId,
      priceCardSource: cost.priceCardSource,
    };
  }
  return {
    availability: "exact",
    exactUsd: cost.exactUsd,
    maximumUsd: cost.maximumUsd,
    minimumUsd: cost.minimumUsd,
    priceCardId: cost.priceCardId,
    priceCardSource: cost.priceCardSource,
  };
}

function decimalMetadata(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) {
    return undefined;
  }

  const numericValue = Number(value);
  return Number.isSafeInteger(numericValue) ? numericValue : undefined;
}

function readClock(nowMilliseconds: MonotonicClock): number | undefined {
  try {
    const reading = nowMilliseconds();
    return Number.isFinite(reading) ? reading : undefined;
  } catch {
    return undefined;
  }
}

function durationMilliseconds(
  startedAt: number | undefined,
  finishedAt: number | undefined,
): number | undefined {
  if (startedAt === undefined || finishedAt === undefined) {
    return undefined;
  }

  const elapsedMilliseconds = finishedAt - startedAt;
  if (!Number.isFinite(elapsedMilliseconds)) {
    return undefined;
  }
  return Math.max(0, Math.round(elapsedMilliseconds));
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
