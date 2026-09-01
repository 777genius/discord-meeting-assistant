import { SelectFocusedEvidence } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import type { Logger } from "@discord-meeting/observability-adapter";
import { SubscriptionRuntimeFocusedEvidenceSelectorAdapter,
  SubscriptionRuntimeGroundedAnswerAdapter, subscriptionRuntimeCliEngine,
  type SubscriptionRuntimeTransportPort } from
  "@discord-meeting/subscription-runtime-adapter";

import type { PlatformConfig } from "../config.js";
import { participantSpeakerAliases } from
  "../config/participant-greeting-profiles.js";

export function createGroundedAnswerGenerator(input: {
  readonly config: PlatformConfig;
  readonly runtimeTransport: SubscriptionRuntimeTransportPort;
  readonly timeoutMs: number;
}) {
  return new SubscriptionRuntimeGroundedAnswerAdapter(input.runtimeTransport, {
    expectedLauncherSha256: input.config.subscriptionRuntime.launcherSha256,
    expectedRuntimeEngine: subscriptionRuntimeCliEngine,
    speakerAliases: participantSpeakerAliases(
      input.config.participantGreetingProfiles,
    ),
    timeoutMs: input.timeoutMs,
  });
}

export function createFocusedEvidenceSelector(input: {
  readonly launcherSha256: string;
  readonly logger: Logger;
  readonly runtimeTransport: SubscriptionRuntimeTransportPort;
  readonly timeoutMs: number;
}): SelectFocusedEvidence {
  return new SelectFocusedEvidence(
    new SubscriptionRuntimeFocusedEvidenceSelectorAdapter(
      input.runtimeTransport,
      { expectedLauncherSha256: input.launcherSha256,
        expectedRuntimeEngine: subscriptionRuntimeCliEngine,
        timeoutMs: input.timeoutMs },
    ),
    (measurement) => {
      input.logger.info("Focused evidence selection settled", measurement);
    },
    () => performance.now(),
  );
}
