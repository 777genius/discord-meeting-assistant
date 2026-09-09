import type {
  IncrementalSummaryGenerationPort,
} from "@discord-meeting/meeting-core/live-meeting";
import {
  SubscriptionRuntimeIncrementalSummaryAdapter,
  subscriptionRuntimeCliEngine,
  subscriptionRuntimeIncrementalMaxOutputTokens,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";

import { SubscriptionRuntimeFarewellClassifier } from
  "../adapters/outbound/subscription-runtime-farewell-classifier.js";
import type { PlatformConfig } from "../config.js";

const incrementalSummaryTimeoutMs = 120_000;

/**
 * Keeps the consumer-owned live-summary port explicit when the optional hosted
 * runtime is absent. Captions continue to project, while summary generation
 * settles as unavailable and can never invent an outline from partial speech.
 */
export function createLiveIncrementalSummaryPort(
  config: PlatformConfig,
  runtimeTransport?: SubscriptionRuntimeTransportPort,
): IncrementalSummaryGenerationPort {
  if (runtimeTransport === undefined || config.subscriptionRuntime === undefined) {
    return new UnavailableIncrementalSummaryPort();
  }
  return new SubscriptionRuntimeIncrementalSummaryAdapter(runtimeTransport, {
    expectedLauncherSha256: config.subscriptionRuntime.launcherSha256,
    expectedRuntimeEngine: subscriptionRuntimeCliEngine,
    maxOutputTokens: subscriptionRuntimeIncrementalMaxOutputTokens,
    maxRecentContextTurns: 256,
    timeoutMs: incrementalSummaryTimeoutMs,
  });
}

class UnavailableIncrementalSummaryPort
  implements IncrementalSummaryGenerationPort
{
  public async generate() {
    return {
      failure: {
        code: "LIVE_SUMMARY_PROVIDER_UNAVAILABLE",
        message: "Incremental summary generation is not configured",
        retryable: false,
      },
      ok: false as const,
    };
  }
}

export function createFarewellClassifier(
  config: PlatformConfig,
  runtimeTransport?: SubscriptionRuntimeTransportPort,
): { readonly farewellClassifier?: SubscriptionRuntimeFarewellClassifier } {
  if (config.conversation === undefined) {
    return {};
  }
  if (runtimeTransport === undefined || config.subscriptionRuntime === undefined) {
    throw new Error("Subscription Runtime is required for voice-assistant features");
  }
  return {
    farewellClassifier: new SubscriptionRuntimeFarewellClassifier(
      runtimeTransport,
      config.subscriptionRuntime.launcherSha256,
    ),
  };
}
