import {
  DomainInvariantError,
  requireNonEmpty,
  requireNonNegativeInteger,
} from "./errors.js";

export interface LiveGenerationUsageSnapshot {
  readonly apiEquivalentCostUsd: number | null;
  readonly cacheWriteInputTokens: number;
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly priceCard: string;
  readonly reasoningOutputTokens: number;
  /** Stable idempotency identity for one provider generation. */
  readonly runId: string;
  readonly totalTokens: number;
}

/** A provider-reported token class that is never represented by a synthetic zero. */
export type LiveGenerationTokenClassSnapshot =
  | {
      readonly availability: "measured";
      readonly value: number;
    }
  | {
      readonly availability: "derived";
      readonly derivedFrom: readonly ["inputTokens", "outputTokens"];
      readonly value: number;
    }
  | {
      readonly availability: "unavailable";
    };

export interface LiveGenerationCostSnapshot {
  readonly exactUsd?: number;
  readonly maximumUsd: number;
  readonly minimumUsd: number;
  readonly priceCardId: string;
  readonly priceCardSource: string;
}

/** Provider-neutral generation telemetry persisted outside business state. */
export interface LiveGenerationTelemetrySnapshot {
  readonly cacheWriteInputTokens: LiveGenerationTokenClassSnapshot;
  readonly cachedInputTokens: LiveGenerationTokenClassSnapshot;
  readonly cost?: LiveGenerationCostSnapshot;
  readonly inputTokens: LiveGenerationTokenClassSnapshot;
  readonly model: string;
  readonly outputTokens: LiveGenerationTokenClassSnapshot;
  readonly reasoningOutputTokens: LiveGenerationTokenClassSnapshot;
  /** Stable idempotency identity for one provider generation. */
  readonly runId: string;
  readonly source: string;
  readonly totalTokens: LiveGenerationTokenClassSnapshot;
}

function requireFiniteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", `${field} must be non-negative`);
  }
  return value;
}

function validateTokenClass(
  input: LiveGenerationTokenClassSnapshot,
  field: string,
  allowDerived: boolean,
): LiveGenerationTokenClassSnapshot {
  const rawToken: unknown = input;
  if (rawToken === null || typeof rawToken !== "object" || Array.isArray(rawToken)) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", `${field} token class is invalid`);
  }
  const token = rawToken as Record<string, unknown>;
  if (token.availability === "unavailable") {
    if ("value" in token || "derivedFrom" in token) {
      throw new DomainInvariantError(
        "INVALID_SNAPSHOT",
        `${field} unavailable token class must not carry a value`,
      );
    }
    return Object.freeze({ availability: "unavailable" });
  }
  if (token.availability === "measured") {
    return Object.freeze({
      availability: "measured",
      value: requireNonNegativeInteger(token.value as number, `${field}.value`),
    });
  }
  if (
    !allowDerived ||
    token.availability !== "derived" ||
    !Array.isArray(token.derivedFrom) ||
    token.derivedFrom.length !== 2 ||
    token.derivedFrom[0] !== "inputTokens" ||
    token.derivedFrom[1] !== "outputTokens"
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", `${field} token availability is invalid`);
  }
  return Object.freeze({
    availability: "derived",
    derivedFrom: ["inputTokens", "outputTokens"] as const,
    value: requireNonNegativeInteger(token.value as number, `${field}.value`),
  });
}

function measuredTokenValue(input: LiveGenerationTokenClassSnapshot): number | undefined {
  return input.availability === "measured" ? input.value : undefined;
}

interface MeasuredGenerationTokenValues {
  readonly cacheWriteInputTokens: number | undefined;
  readonly cachedInputTokens: number | undefined;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly reasoningOutputTokens: number | undefined;
}

function validateMeasuredInputTokens(values: MeasuredGenerationTokenValues): void {
  const {
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens,
  } = values;
  if (
    inputTokens !== undefined &&
    cachedInputTokens !== undefined &&
    cachedInputTokens > inputTokens
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "cached input exceeds input");
  }
  if (
    inputTokens !== undefined &&
    cachedInputTokens !== undefined &&
    cacheWriteInputTokens !== undefined &&
    cachedInputTokens + cacheWriteInputTokens > inputTokens
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "cache-write input exceeds input");
  }
}

function validateMeasuredOutputTokens(values: MeasuredGenerationTokenValues): void {
  if (
    values.outputTokens !== undefined &&
    values.reasoningOutputTokens !== undefined &&
    values.reasoningOutputTokens > values.outputTokens
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "reasoning output exceeds output");
  }
}

function validateTotalTokens(
  totalTokens: LiveGenerationTokenClassSnapshot,
  values: MeasuredGenerationTokenValues,
): void {
  if (totalTokens.availability === "derived") {
    if (values.inputTokens === undefined || values.outputTokens === undefined) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "derived generation total is inconsistent");
    }
    const calculated = values.inputTokens + values.outputTokens;
    if (!Number.isSafeInteger(calculated) || totalTokens.value !== calculated) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "derived generation total is inconsistent");
    }
    return;
  }
  if (
    totalTokens.availability === "measured" &&
    values.inputTokens !== undefined &&
    values.outputTokens !== undefined &&
    totalTokens.value < values.inputTokens + values.outputTokens
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "generation total is inconsistent");
  }
}

function normalizeGenerationCost(input: LiveGenerationCostSnapshot): LiveGenerationCostSnapshot {
  const minimumUsd = requireFiniteNonNegative(input.minimumUsd, "telemetry.cost.minimumUsd");
  const maximumUsd = requireFiniteNonNegative(input.maximumUsd, "telemetry.cost.maximumUsd");
  if (minimumUsd > maximumUsd) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "generation cost range is inverted");
  }
  const exactUsd = input.exactUsd === undefined
    ? undefined
    : requireFiniteNonNegative(input.exactUsd, "telemetry.cost.exactUsd");
  if (exactUsd !== undefined && (exactUsd !== minimumUsd || exactUsd !== maximumUsd)) {
    throw new DomainInvariantError(
      "INVALID_SNAPSHOT",
      "exact generation cost must collapse the cost range",
    );
  }
  return Object.freeze({
    ...(exactUsd === undefined ? {} : { exactUsd }),
    maximumUsd,
    minimumUsd,
    priceCardId: requireNonEmpty(input.priceCardId, "telemetry.cost.priceCardId"),
    priceCardSource: requireNonEmpty(input.priceCardSource, "telemetry.cost.priceCardSource"),
  });
}

export function normalizeLiveGenerationUsage(
  input: LiveGenerationUsageSnapshot,
): LiveGenerationUsageSnapshot {
  const usage = {
    apiEquivalentCostUsd:
      input.apiEquivalentCostUsd === null
        ? null
        : requireFiniteNonNegative(input.apiEquivalentCostUsd, "usage.apiEquivalentCostUsd"),
    cacheWriteInputTokens: requireNonNegativeInteger(
      input.cacheWriteInputTokens,
      "usage.cacheWriteInputTokens",
    ),
    cachedInputTokens: requireNonNegativeInteger(
      input.cachedInputTokens,
      "usage.cachedInputTokens",
    ),
    inputTokens: requireNonNegativeInteger(input.inputTokens, "usage.inputTokens"),
    model: requireNonEmpty(input.model, "usage.model"),
    outputTokens: requireNonNegativeInteger(input.outputTokens, "usage.outputTokens"),
    priceCard: requireNonEmpty(input.priceCard, "usage.priceCard"),
    reasoningOutputTokens: requireNonNegativeInteger(
      input.reasoningOutputTokens,
      "usage.reasoningOutputTokens",
    ),
    runId: requireNonEmpty(input.runId, "usage.runId"),
    totalTokens: requireNonNegativeInteger(input.totalTokens, "usage.totalTokens"),
  };
  if (
    usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens ||
    usage.reasoningOutputTokens > usage.outputTokens ||
    usage.totalTokens < usage.inputTokens + usage.outputTokens
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "generation usage totals are inconsistent");
  }
  return Object.freeze(usage);
}

export function normalizeLiveGenerationTelemetry(
  input: LiveGenerationTelemetrySnapshot,
): LiveGenerationTelemetrySnapshot {
  const inputTokens = validateTokenClass(input.inputTokens, "telemetry.inputTokens", false);
  const cachedInputTokens = validateTokenClass(
    input.cachedInputTokens,
    "telemetry.cachedInputTokens",
    false,
  );
  const cacheWriteInputTokens = validateTokenClass(
    input.cacheWriteInputTokens,
    "telemetry.cacheWriteInputTokens",
    false,
  );
  const outputTokens = validateTokenClass(input.outputTokens, "telemetry.outputTokens", false);
  const reasoningOutputTokens = validateTokenClass(
    input.reasoningOutputTokens,
    "telemetry.reasoningOutputTokens",
    false,
  );
  const totalTokens = validateTokenClass(input.totalTokens, "telemetry.totalTokens", true);
  const measuredValues: MeasuredGenerationTokenValues = {
    cacheWriteInputTokens: measuredTokenValue(cacheWriteInputTokens),
    cachedInputTokens: measuredTokenValue(cachedInputTokens),
    inputTokens: measuredTokenValue(inputTokens),
    outputTokens: measuredTokenValue(outputTokens),
    reasoningOutputTokens: measuredTokenValue(reasoningOutputTokens),
  };
  validateMeasuredInputTokens(measuredValues);
  validateMeasuredOutputTokens(measuredValues);
  validateTotalTokens(totalTokens, measuredValues);

  return Object.freeze({
    cacheWriteInputTokens,
    cachedInputTokens,
    ...(input.cost === undefined ? {} : { cost: normalizeGenerationCost(input.cost) }),
    inputTokens,
    model: requireNonEmpty(input.model, "telemetry.model"),
    outputTokens,
    reasoningOutputTokens,
    runId: requireNonEmpty(input.runId, "telemetry.runId"),
    source: requireNonEmpty(input.source, "telemetry.source"),
    totalTokens,
  });
}
