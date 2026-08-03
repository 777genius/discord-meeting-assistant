import type {
  LiveGenerationTelemetrySnapshot,
  LiveGenerationUsageSnapshot,
} from "@discord-meeting/meeting-core";

import { SubscriptionRuntimeAdapterError } from "./errors.js";
import {
  subscriptionRuntimeIncrementalModel,
  type SubscriptionRuntimeCostRange,
  type SubscriptionRuntimeTelemetry,
  type SubscriptionRuntimeTokenAvailability,
  type SubscriptionRuntimeUsage,
} from "./subscription-runtime-contract.js";

export const lunaStandardPriceCard = Object.freeze({
  cacheWriteInputUsdPerMillion: 0.25,
  cachedInputUsdPerMillion: 0.02,
  id: "openai-standard-2026-08-02",
  inputUsdPerMillion: 0.20,
  maximumInputTokens: 272_000,
  model: subscriptionRuntimeIncrementalModel,
  outputUsdPerMillion: 1.20,
  source: "https://developers.openai.com/api/docs/pricing#text-tokens",
  tier: "standard",
});

export const lunaLongContextPriceCard = Object.freeze({
  cacheWriteInputUsdPerMillion: 0.50,
  cachedInputUsdPerMillion: 0.04,
  id: `${lunaStandardPriceCard.id}:context-over-272000`,
  inputUsdPerMillion: 0.40,
  model: subscriptionRuntimeIncrementalModel,
  outputUsdPerMillion: 1.80,
  source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
  tier: "long-context",
});

type LunaPriceCard =
  | typeof lunaLongContextPriceCard
  | typeof lunaStandardPriceCard;

/**
 * A bounded price estimate when Codex reports input/cached/output but does not
 * expose cache-write input. `exactUsd` is intentionally absent in that case.
 */
export type LunaApiEquivalentCostRange = SubscriptionRuntimeCostRange;

export function mapLunaGenerationUsage(
  usage: SubscriptionRuntimeUsage,
  runId: string,
): LiveGenerationUsageSnapshot {
  validateUsage(usage);
  const priceCard = priceCardForUsage(usage);
  return {
    apiEquivalentCostUsd: apiEquivalentCost(usage, priceCard),
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    inputTokens: usage.inputTokens,
    model: subscriptionRuntimeIncrementalModel,
    outputTokens: usage.outputTokens,
    priceCard: priceCard.id,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    runId,
    totalTokens: usage.totalTokens,
  };
}

export function mapLunaGenerationTelemetry(
  telemetry: SubscriptionRuntimeTelemetry,
  runId: string,
): LiveGenerationTelemetrySnapshot {
  const normalized = {
    cacheWriteInputTokens: mapTokenClass(telemetry.cacheWriteInputTokens),
    cachedInputTokens: mapTokenClass(telemetry.cachedInputTokens),
    inputTokens: mapTokenClass(telemetry.inputTokens),
    outputTokens: mapTokenClass(telemetry.outputTokens),
    reasoningOutputTokens: mapTokenClass(telemetry.reasoningOutputTokens),
    totalTokens: mapTokenClass(telemetry.totalTokens, true),
  };
  const calculatedCost = canPriceTelemetry(telemetry)
    ? calculateLunaApiEquivalentCostRange(telemetry)
    : undefined;
  const cost = telemetry.cost ?? calculatedCost;
  if (telemetry.cost !== undefined && calculatedCost !== undefined) {
    assertMatchingCostRange(telemetry.cost, calculatedCost);
  }
  return {
    ...normalized,
    ...(cost === undefined ? {} : { cost }),
    model: subscriptionRuntimeIncrementalModel,
    runId,
    source: telemetry.source,
  };
}

/**
 * Prices partial Codex telemetry without treating an unavailable cache-write
 * class as zero. The lower bound assumes no cache writes; the upper bound
 * assumes all non-cached input was written to cache.
 */
export function calculateLunaApiEquivalentCostRange(
  telemetry: SubscriptionRuntimeTelemetry,
): LunaApiEquivalentCostRange {
  const inputTokens = measuredTokenValue(telemetry.inputTokens, "inputTokens");
  const cachedInputTokens = measuredTokenValue(
    telemetry.cachedInputTokens,
    "cachedInputTokens",
  );
  const outputTokens = measuredTokenValue(telemetry.outputTokens, "outputTokens");
  if (cachedInputTokens > inputTokens) {
    throw invalidTelemetry("cachedInputTokens exceeds inputTokens");
  }
  validateDependentTelemetry(telemetry, inputTokens, outputTokens);
  const priceCard = priceCardForInputTokens(inputTokens);
  const cacheWriteInputTokens = optionalMeasuredTokenValue(
    telemetry.cacheWriteInputTokens,
    "cacheWriteInputTokens",
  );
  const nonCachedInputTokens = inputTokens - cachedInputTokens;

  if (
    cacheWriteInputTokens !== undefined &&
    cacheWriteInputTokens > nonCachedInputTokens
  ) {
    throw invalidTelemetry("cacheWriteInputTokens exceeds non-cached input");
  }

  const minimumUsd = roundedUsd(
    cachedInputTokens * priceCard.cachedInputUsdPerMillion +
      nonCachedInputTokens * priceCard.inputUsdPerMillion +
      outputTokens * priceCard.outputUsdPerMillion,
  );
  const maximumUsd = roundedUsd(
    cachedInputTokens * priceCard.cachedInputUsdPerMillion +
      nonCachedInputTokens * priceCard.cacheWriteInputUsdPerMillion +
      outputTokens * priceCard.outputUsdPerMillion,
  );
  if (minimumUsd > maximumUsd) {
    throw invalidTelemetry("calculated cost range is inverted");
  }
  if (cacheWriteInputTokens === undefined) {
    return {
      maximumUsd,
      minimumUsd,
      priceCardId: priceCard.id,
      priceCardSource: priceCard.source,
    };
  }

  const exactUsd = roundedUsd(
    cachedInputTokens * priceCard.cachedInputUsdPerMillion +
      (nonCachedInputTokens - cacheWriteInputTokens) *
        priceCard.inputUsdPerMillion +
      cacheWriteInputTokens * priceCard.cacheWriteInputUsdPerMillion +
      outputTokens * priceCard.outputUsdPerMillion,
  );
  return {
    exactUsd,
    maximumUsd: exactUsd,
    minimumUsd: exactUsd,
    priceCardId: priceCard.id,
    priceCardSource: priceCard.source,
  };
}

function priceCardForUsage(usage: SubscriptionRuntimeUsage): LunaPriceCard {
  return priceCardForInputTokens(usage.inputTokens);
}

function priceCardForInputTokens(inputTokens: number): LunaPriceCard {
  return inputTokens <= lunaStandardPriceCard.maximumInputTokens
    ? lunaStandardPriceCard
    : lunaLongContextPriceCard;
}

function apiEquivalentCost(
  usage: SubscriptionRuntimeUsage,
  priceCard: LunaPriceCard,
): number {
  const uncachedInputTokens =
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens;
  const millionTokenCost =
    uncachedInputTokens * priceCard.inputUsdPerMillion +
    usage.cachedInputTokens * priceCard.cachedInputUsdPerMillion +
    usage.cacheWriteInputTokens * priceCard.cacheWriteInputUsdPerMillion +
    usage.outputTokens * priceCard.outputUsdPerMillion;
  // Reasoning tokens are a subset of outputTokens and must not be billed twice.
  return roundedUsd(millionTokenCost);
}

function measuredTokenValue(
  token: SubscriptionRuntimeTokenAvailability,
  label: string,
): number {
  if (token.availability !== "measured") {
    throw invalidTelemetry(`${label} is not measured`);
  }
  return requireTokenValue(token.value, label);
}

function mapTokenClass(
  token: SubscriptionRuntimeTokenAvailability,
  allowDerived = false,
): LiveGenerationTelemetrySnapshot["inputTokens"] {
  if (token.availability === "unavailable") {
    return { availability: "unavailable" };
  }
  if (token.availability === "measured") {
    return { availability: "measured", value: requireTokenValue(token.value, "token") };
  }
  if (!allowDerived) {
    throw invalidTelemetry("only totalTokens may be derived");
  }
  return {
    availability: "derived",
    derivedFrom: ["inputTokens", "outputTokens"],
    value: requireTokenValue(token.value, "derived token"),
  };
}

function canPriceTelemetry(telemetry: SubscriptionRuntimeTelemetry): boolean {
  return (
    telemetry.inputTokens.availability === "measured" &&
    telemetry.cachedInputTokens.availability === "measured" &&
    telemetry.outputTokens.availability === "measured"
  );
}

function assertMatchingCostRange(
  actual: SubscriptionRuntimeCostRange,
  expected: SubscriptionRuntimeCostRange,
): void {
  if (
    actual.exactUsd !== expected.exactUsd ||
    actual.maximumUsd !== expected.maximumUsd ||
    actual.minimumUsd !== expected.minimumUsd ||
    actual.priceCardId !== expected.priceCardId ||
    actual.priceCardSource !== expected.priceCardSource
  ) {
    throw invalidTelemetry("runtime cost range conflicts with the Luna price card");
  }
}

function optionalMeasuredTokenValue(
  token: SubscriptionRuntimeTokenAvailability,
  label: string,
): number | undefined {
  if (token.availability === "unavailable") {
    return undefined;
  }
  if (token.availability === "derived") {
    throw invalidTelemetry(`${label} must not be derived`);
  }
  return requireTokenValue(token.value, label);
}

function requireTokenValue(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidTelemetry(`${label} is not a valid token count`);
  }
  return value;
}

function validateDependentTelemetry(
  telemetry: SubscriptionRuntimeTelemetry,
  inputTokens: number,
  outputTokens: number,
): void {
  if (telemetry.reasoningOutputTokens.availability === "derived") {
    throw invalidTelemetry("reasoningOutputTokens must not be derived");
  }
  if (
    telemetry.reasoningOutputTokens.availability === "measured" &&
    requireTokenValue(
      telemetry.reasoningOutputTokens.value,
      "reasoningOutputTokens",
    ) > outputTokens
  ) {
    throw invalidTelemetry("reasoningOutputTokens exceeds outputTokens");
  }
  if (telemetry.totalTokens.availability === "unavailable") {
    return;
  }
  const totalTokens = requireTokenValue(telemetry.totalTokens.value, "totalTokens");
  const derivedTotal = inputTokens + outputTokens;
  if (!Number.isSafeInteger(derivedTotal)) {
    throw invalidTelemetry("inputTokens plus outputTokens is not safe");
  }
  if (
    telemetry.totalTokens.availability === "derived" &&
    totalTokens !== derivedTotal
  ) {
    throw invalidTelemetry("derived totalTokens is inconsistent");
  }
  if (
    telemetry.totalTokens.availability === "measured" &&
    totalTokens < derivedTotal
  ) {
    throw invalidTelemetry("totalTokens is less than input plus output");
  }
}

function roundedUsd(millionTokenCost: number): number {
  return Number((millionTokenCost / 1_000_000).toFixed(12));
}

function invalidTelemetry(detail: string): SubscriptionRuntimeAdapterError {
  return new SubscriptionRuntimeAdapterError(
    "invalid_provider_response",
    `Subscription runtime returned inconsistent generation telemetry: ${detail}`,
  );
}

function validateUsage(usage: SubscriptionRuntimeUsage): void {
  const tokenValues = [
    usage.cacheWriteInputTokens,
    usage.cachedInputTokens,
    usage.inputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.totalTokens,
  ];
  if (tokenValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_provider_response",
      "Subscription runtime returned invalid generation usage",
    );
  }
  if (
    usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens ||
    usage.reasoningOutputTokens > usage.outputTokens ||
    usage.totalTokens < usage.inputTokens + usage.outputTokens
  ) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_provider_response",
      "Subscription runtime returned inconsistent generation usage",
    );
  }
}
