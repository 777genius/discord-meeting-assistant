import type {
  ConversationLatencyObserverPort,
  ConversationPlaybackObserverPort,
} from "@discord-meeting/meeting-core/conversation";
import type { Logger } from "@discord-meeting/observability-adapter";

export function createConversationLatencyLogger(
  logger: Pick<Logger, "info">,
): ConversationLatencyObserverPort {
  return {
    observeConversationLatency: (observation) => {
      logger.info("Live conversation latency observed", { ...observation });
    },
  };
}

export function createConversationPlaybackLogger(
  logger: Pick<Logger, "info">,
  timeOriginMilliseconds = performance.timeOrigin,
): ConversationPlaybackObserverPort {
  return {
    observeConversationPlayback: (observation) => {
      const sharedFields = {
        meetingId: observation.meetingId,
        playbackAttemptId: observation.playbackAttemptId,
        playbackKind: observation.playbackKind,
        turnId: observation.turnId,
      };
      switch (observation.status) {
        case "started":
          logger.info("Conversation playback started", {
            ...sharedFields,
            playbackStartedAtEpochMs: observation.startedAtMs,
            playbackStartedAtMonotonicMs: observation.startedAtMs - timeOriginMilliseconds,
          });
          return;
        case "finished":
          logger.info("Conversation playback finished", {
            ...sharedFields,
            playbackFinishedAtEpochMs: observation.finishedAtMs,
            playbackFinishedAtMonotonicMs: observation.finishedAtMs - timeOriginMilliseconds,
          });
          return;
        case "settled":
          logger.info("Conversation playback settled", {
            ...sharedFields,
            playbackSettledAtEpochMs: observation.settledAtMs,
            playbackSettledAtMonotonicMs: observation.settledAtMs - timeOriginMilliseconds,
            settlement: observation.settlement,
          });
      }
    },
  };
}
