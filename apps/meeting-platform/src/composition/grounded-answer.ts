import { GroundedMeetingAnswer } from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  SubscriptionRuntimeGroundedAnswerAdapter,
  subscriptionRuntimeCliEngine,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";

import type { PlatformConfig } from "../config.js";
import { localFinalReplyPolicy } from "./meeting-knowledge.js";

/** One shared grounded-generation use case for durable Discord and live voice. */
export function createPlatformGroundedMeetingAnswer(input: {
  readonly config: PlatformConfig;
  readonly runtimeTransport: SubscriptionRuntimeTransportPort;
}): GroundedMeetingAnswer | undefined {
  if (
    input.config.meetingKnowledge?.localFinalReply !== true &&
    input.config.conversation === undefined
  ) {
    return undefined;
  }
  return new GroundedMeetingAnswer(
    new SubscriptionRuntimeGroundedAnswerAdapter(input.runtimeTransport, {
      expectedLauncherSha256: input.config.subscriptionRuntime.launcherSha256,
      expectedRuntimeEngine: subscriptionRuntimeCliEngine,
    }),
    localFinalReplyPolicy.groundingSafety,
  );
}
