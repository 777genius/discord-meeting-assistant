import type { LiveGenerationUsageSnapshot } from "@discord-meeting/meeting-core";

import { SubscriptionRuntimeAdapterError } from "./errors.js";
import {
  subscriptionRuntimeIncrementalModel,
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
  source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
  tier: "standard",
});

const unavailableLongContextPriceCard = `${lunaStandardPriceCard.id}:context-over-272000-unpriced`;

export function mapLunaGenerationUsage(
  usage: SubscriptionRuntimeUsage,
  runId: string,
): LiveGenerationUsageSnapshot {
  validateUsage(usage);
  const hasShortContextPrice = usage.inputTokens <= lunaStandardPriceCard.maximumInputTokens;
  return {
    apiEquivalentCostUsd: hasShortContextPrice ? shortContextCost(usage) : null,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    inputTokens: usage.inputTokens,
    model: subscriptionRuntimeIncrementalModel,
    outputTokens: usage.outputTokens,
    priceCard: hasShortContextPrice
      ? lunaStandardPriceCard.id
      : unavailableLongContextPriceCard,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    runId,
    totalTokens: usage.totalTokens,
  };
}

function shortContextCost(usage: SubscriptionRuntimeUsage): number {
  const uncachedInputTokens =
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens;
  const millionTokenCost =
    uncachedInputTokens * lunaStandardPriceCard.inputUsdPerMillion +
    usage.cachedInputTokens * lunaStandardPriceCard.cachedInputUsdPerMillion +
    usage.cacheWriteInputTokens * lunaStandardPriceCard.cacheWriteInputUsdPerMillion +
    usage.outputTokens * lunaStandardPriceCard.outputUsdPerMillion;
  // Reasoning tokens are a subset of outputTokens and must not be billed twice.
  return Number((millionTokenCost / 1_000_000).toFixed(12));
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
