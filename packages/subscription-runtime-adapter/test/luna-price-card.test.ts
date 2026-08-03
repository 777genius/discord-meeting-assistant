import { describe, expect, it } from "vitest";

import {
  calculateLunaApiEquivalentCostRange,
  lunaLongContextPriceCard,
  lunaStandardPriceCard,
  type SubscriptionRuntimeTelemetry,
} from "../src/index.js";

function codexJsonlTelemetry(input: {
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens?: number;
}): SubscriptionRuntimeTelemetry {
  return {
    source: "codex_exec_jsonl",
    cacheWriteInputTokens: { availability: "unavailable" },
    cachedInputTokens: {
      availability: "measured",
      value: input.cachedInputTokens,
    },
    inputTokens: { availability: "measured", value: input.inputTokens },
    outputTokens: { availability: "measured", value: input.outputTokens },
    reasoningOutputTokens: {
      availability: "measured",
      value: input.reasoningOutputTokens ?? 0,
    },
    totalTokens: {
      availability: "derived",
      derivedFrom: ["inputTokens", "outputTokens"],
      value: input.inputTokens + input.outputTokens,
    },
  };
}

describe("calculateLunaApiEquivalentCostRange", () => {
  it("returns an honest short-context range when cache-write input is unavailable", () => {
    const estimate = calculateLunaApiEquivalentCostRange(
      codexJsonlTelemetry({
        cachedInputTokens: 200,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
      }),
    );

    expect(estimate).toEqual({
      maximumUsd: 0.000_564,
      minimumUsd: 0.000_524,
      priceCardId: lunaStandardPriceCard.id,
      priceCardSource: lunaStandardPriceCard.source,
    });
    expect(estimate.minimumUsd).toBeLessThanOrEqual(estimate.maximumUsd);
    expect(estimate).not.toHaveProperty("exactUsd");
  });

  it("uses the documented long-context rates for partial telemetry", () => {
    const estimate = calculateLunaApiEquivalentCostRange(
      codexJsonlTelemetry({
        cachedInputTokens: 0,
        inputTokens: 272_001,
        outputTokens: 1_000,
      }),
    );

    expect(estimate).toEqual({
      maximumUsd: 0.137_800_5,
      minimumUsd: 0.110_600_4,
      priceCardId: lunaLongContextPriceCard.id,
      priceCardSource: lunaLongContextPriceCard.source,
    });
  });

  it("reports an exact amount only when cache-write input is measured", () => {
    const telemetry = codexJsonlTelemetry({
      cachedInputTokens: 200,
      inputTokens: 1_000,
      outputTokens: 300,
      reasoningOutputTokens: 100,
    });
    const estimate = calculateLunaApiEquivalentCostRange({
      ...telemetry,
      cacheWriteInputTokens: { availability: "measured", value: 100 },
    });

    expect(estimate).toEqual({
      exactUsd: 0.000_529,
      maximumUsd: 0.000_529,
      minimumUsd: 0.000_529,
      priceCardId: lunaStandardPriceCard.id,
      priceCardSource: lunaStandardPriceCard.source,
    });
  });
});
