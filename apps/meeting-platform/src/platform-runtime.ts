/** Compatibility entry point for the Meeting Platform composition root. */
export {
  createPlatformHistoricalDeletion,
  startMeetingPlatform,
} from "./composition/platform-runtime.js";
export {
  closeMeetingPlatformResources,
} from "./composition/platform-shutdown.js";
export {
  createConversationCoordinator,
  createConversationLatencyLogger,
  createConversationPlaybackLogger,
  createGroundedKnowledgeAnswerLogger,
} from "./composition/discord-live.js";
export {
  createVoicetextBatchFinalTranscriptionOptions,
} from "./composition/transcription.js";
