import type {
  ConversationLatencyObserverPort,
  ConversationPlaybackObserverPort,
  GroundedKnowledgeAnswerObserverPort,
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
        ...(observation.preparedAssetSha256 === undefined
          ? {}
          : { preparedAssetSha256: observation.preparedAssetSha256 }),
        ...(observation.speechProvenance === undefined
          ? {}
          : {
              speechProvenance: observation.speechProvenance,
              ...(observation.ttsAttestation === undefined
                ? {}
                : { ttsAttestation: observation.ttsAttestation }),
            }),
        ...(observation.thinkingCuePcmSha256 === undefined
          ? {}
          : { thinkingCuePcmSha256: observation.thinkingCuePcmSha256 }),
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

export function createGroundedKnowledgeAnswerLogger(
  logger: Pick<Logger, "info">,
): GroundedKnowledgeAnswerObserverPort {
  return {
    observeGroundedKnowledgeAnswer: (observation) => {
      const fields = observation.status === "cancelled"
        ? {
            ...observation,
            cancellationObservedAt: new Date(
              observation.cancellationObservedAtMs,
            ).toISOString(),
          }
        : observation;
      logger.info(
        observation.status === "validated"
          ? "Grounded knowledge answer validated"
          : "Grounded knowledge answer cancelled",
        { ...fields },
      );
    },
  };
}
