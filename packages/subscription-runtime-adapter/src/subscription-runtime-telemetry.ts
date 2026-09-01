import type {
  SubscriptionRuntimeTelemetry,
  SubscriptionRuntimeTokenAvailability,
  SubscriptionRuntimeUsage,
} from "./subscription-runtime-contract.js";

import {
  arrayValue,
  booleanValue,
  enumValue,
  integerValue,
  nonNegativeFiniteNumber,
  recordValue,
  requiredString,
} from "./grpc-value-readers.js";

export function completeUsage(value: unknown): SubscriptionRuntimeUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  if (usage.complete !== true) {
    return undefined;
  }
  const parsed: SubscriptionRuntimeUsage = {
    cacheWriteInputTokens: integerValue(
      usage.cacheWriteInputTokens,
      "usage.cacheWriteInputTokens",
    ),
    cachedInputTokens: integerValue(usage.cachedInputTokens, "usage.cachedInputTokens"),
    inputTokens: integerValue(usage.inputTokens, "usage.inputTokens"),
    outputTokens: integerValue(usage.outputTokens, "usage.outputTokens"),
    reasoningOutputTokens: integerValue(
      usage.reasoningOutputTokens,
      "usage.reasoningOutputTokens",
    ),
    totalTokens: integerValue(usage.totalTokens, "usage.totalTokens"),
  };
  if (
    parsed.cachedInputTokens + parsed.cacheWriteInputTokens > parsed.inputTokens ||
    parsed.reasoningOutputTokens > parsed.outputTokens ||
    parsed.totalTokens < parsed.inputTokens + parsed.outputTokens
  ) {
    throw new Error("Subscription runtime usage totals are inconsistent");
  }
  return parsed;
}

export function partialTelemetry(
  value: unknown,
): SubscriptionRuntimeTelemetry | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const telemetry = recordValue(value, "telemetry");
  const parsed: SubscriptionRuntimeTelemetry = {
    cacheWriteInputTokens: tokenClass(
      telemetry.cacheWriteInputTokens,
      "telemetry.cacheWriteInputTokens",
      false,
    ),
    cachedInputTokens: tokenClass(
      telemetry.cachedInputTokens,
      "telemetry.cachedInputTokens",
      false,
    ),
    ...(telemetry.cost === undefined || telemetry.cost === null
      ? {}
      : { cost: costRange(telemetry.cost) }),
    inputTokens: tokenClass(telemetry.inputTokens, "telemetry.inputTokens", false),
    outputTokens: tokenClass(telemetry.outputTokens, "telemetry.outputTokens", false),
    reasoningOutputTokens: tokenClass(
      telemetry.reasoningOutputTokens,
      "telemetry.reasoningOutputTokens",
      false,
    ),
    source: telemetrySource(telemetry.source),
    totalTokens: tokenClass(telemetry.totalTokens, "telemetry.totalTokens", true),
  };
  validatePartialTelemetry(parsed);
  return parsed;
}

function telemetrySource(value: unknown): SubscriptionRuntimeTelemetry["source"] {
  const source = requiredString(value, "telemetry.source");
  if (source !== "codex_exec_jsonl" && source !== "runtime_bridge") {
    throw new Error("telemetry.source is unsupported");
  }
  return source;
}

function tokenClass(
  value: unknown,
  field: string,
  allowDerived: boolean,
): SubscriptionRuntimeTokenAvailability {
  const token = recordValue(value, field);
  const availability = enumValue(token.availability);
  if (
    availability === "AGENT_RUNTIME_TOKEN_AVAILABILITY_UNAVAILABLE" ||
    availability === "3"
  ) {
    return { availability: "unavailable" };
  }
  if (
    availability === "AGENT_RUNTIME_TOKEN_AVAILABILITY_MEASURED" ||
    availability === "1"
  ) {
    return { availability: "measured", value: integerValue(token.value, `${field}.value`) };
  }
  if (
    !allowDerived ||
    (availability !== "AGENT_RUNTIME_TOKEN_AVAILABILITY_DERIVED" && availability !== "2")
  ) {
    throw new Error(`${field}.availability is invalid`);
  }
  const derivedFrom = arrayValue(token.derivedFrom).map(enumValue);
  if (
    derivedFrom.length !== 2 ||
    !isInputTokenSource(derivedFrom[0]) ||
    !isOutputTokenSource(derivedFrom[1])
  ) {
    throw new Error(`${field}.derivedFrom is invalid`);
  }
  return {
    availability: "derived",
    derivedFrom: ["inputTokens", "outputTokens"],
    value: integerValue(token.value, `${field}.value`),
  };
}

function costRange(value: unknown): NonNullable<SubscriptionRuntimeTelemetry["cost"]> {
  const cost = recordValue(value, "telemetry.cost");
  const minimumUsd = nonNegativeFiniteNumber(cost.minimumUsd, "telemetry.cost.minimumUsd");
  const maximumUsd = nonNegativeFiniteNumber(cost.maximumUsd, "telemetry.cost.maximumUsd");
  if (minimumUsd > maximumUsd) {
    throw new Error("telemetry cost range is inverted");
  }
  const exactUsd = booleanValue(cost.hasExactUsd)
    ? nonNegativeFiniteNumber(cost.exactUsd, "telemetry.cost.exactUsd")
    : undefined;
  if (exactUsd !== undefined && (exactUsd !== minimumUsd || exactUsd !== maximumUsd)) {
    throw new Error("telemetry exact cost must collapse the range");
  }
  return {
    ...(exactUsd === undefined ? {} : { exactUsd }),
    maximumUsd,
    minimumUsd,
    priceCardId: requiredString(cost.priceCardId, "telemetry.cost.priceCardId"),
    priceCardSource: requiredString(cost.priceCardSource, "telemetry.cost.priceCardSource"),
  };
}

interface MeasuredTelemetryValues {
  readonly cacheWriteInputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
}

function validatePartialTelemetry(telemetry: SubscriptionRuntimeTelemetry): void {
  const cacheWriteInputTokens = measuredTokenValue(telemetry.cacheWriteInputTokens);
  const cachedInputTokens = measuredTokenValue(telemetry.cachedInputTokens);
  const inputTokens = measuredTokenValue(telemetry.inputTokens);
  const outputTokens = measuredTokenValue(telemetry.outputTokens);
  const reasoningOutputTokens = measuredTokenValue(telemetry.reasoningOutputTokens);
  const values: MeasuredTelemetryValues = {
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
  };
  validateInputTokens(values);
  validateOutputTokens(values);
  validateTotalTokens(telemetry.totalTokens, values);
  validateCostTokens(telemetry, values);
}

function validateInputTokens(values: MeasuredTelemetryValues): void {
  const { cacheWriteInputTokens, cachedInputTokens, inputTokens } = values;
  if (
    inputTokens !== undefined &&
    cachedInputTokens !== undefined &&
    cachedInputTokens > inputTokens
  ) {
    throw new Error("telemetry cached input exceeds input");
  }
  if (
    inputTokens !== undefined &&
    cachedInputTokens !== undefined &&
    cacheWriteInputTokens !== undefined &&
    cachedInputTokens + cacheWriteInputTokens > inputTokens
  ) {
    throw new Error("telemetry cache-write input exceeds input");
  }
}

function validateOutputTokens(values: MeasuredTelemetryValues): void {
  if (
    values.outputTokens !== undefined &&
    values.reasoningOutputTokens !== undefined &&
    values.reasoningOutputTokens > values.outputTokens
  ) {
    throw new Error("telemetry reasoning output exceeds output");
  }
}

function validateTotalTokens(
  total: SubscriptionRuntimeTokenAvailability,
  values: MeasuredTelemetryValues,
): void {
  const { inputTokens, outputTokens } = values;
  const calculated =
    inputTokens === undefined || outputTokens === undefined
      ? undefined
      : inputTokens + outputTokens;
  if (
    total.availability === "derived" &&
    (calculated === undefined || !Number.isSafeInteger(calculated) || total.value !== calculated)
  ) {
    throw new Error("telemetry derived total is inconsistent");
  }
  if (
    total.availability === "measured" &&
    calculated !== undefined &&
    total.value < calculated
  ) {
    throw new Error("telemetry total is inconsistent");
  }
}

function validateCostTokens(
  telemetry: SubscriptionRuntimeTelemetry,
  values: MeasuredTelemetryValues,
): void {
  if (
    telemetry.cost !== undefined &&
    (values.inputTokens === undefined ||
      values.cachedInputTokens === undefined ||
      values.outputTokens === undefined ||
      (telemetry.cost.exactUsd !== undefined && values.cacheWriteInputTokens === undefined))
  ) {
    throw new Error("telemetry cost does not match available token classes");
  }
}

function measuredTokenValue(token: SubscriptionRuntimeTokenAvailability): number | undefined {
  return token.availability === "measured" ? token.value : undefined;
}

function isInputTokenSource(value: string | undefined): boolean {
  return value === "AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_INPUT" || value === "1";
}

function isOutputTokenSource(value: string | undefined): boolean {
  return value === "AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_OUTPUT" || value === "2";
}
