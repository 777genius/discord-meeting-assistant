import {
  MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS,
  PCM_S16LE_CHANNELS,
  PCM_S16LE_SAMPLE_RATE_HERTZ,
  type ConversationVoiceEvidence,
  type ConversationVoiceEvidenceInput,
} from "./conversation-voice-observer.js";

export function createConversationVoiceEvidence(
  input: ConversationVoiceEvidenceInput,
): ConversationVoiceEvidence {
  return Object.freeze({
    capture: Object.freeze({
      acceptedDurationMilliseconds: input.capture.acceptedDurationMilliseconds,
      acceptedPacketCount: input.capture.acceptedPacketCount,
      cancellation: Object.freeze({ status: "not-observed" as const }),
      endedAt: input.capture.endedAt,
      expectedDuration: Object.freeze({ ...input.expectedDuration }),
      firstPacketAt: input.capture.firstPacketAt,
      ignoredDuplicatePacketCount: input.capture.ignoredDuplicatePacketCount,
      ignoredLatePacketCount: input.capture.ignoredLatePacketCount,
      limits: Object.freeze({
        captureTimeoutMilliseconds: input.captureTimeoutMilliseconds,
        maxCaptureDurationMilliseconds:
          MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS,
        maxPcmBytes: input.maxPcmBytes,
      }),
      pcm: input.capture.pcm,
      startedAt: input.capture.startedAt,
      termination: "expected-duration-reached" as const,
    }),
    correlation: Object.freeze({
      attemptId: input.attemptId,
      provenance: "operator-supplied" as const,
      purpose: input.purpose,
      recordingId: input.recordingId,
      verification: "not-run" as const,
      turnId: input.turnId,
    }),
    kind: "conversation-voice-observer-evidence" as const,
    observer: Object.freeze({
      applicationId: input.observerApplicationId,
      authenticatedBotId: input.authenticatedBotId,
      guildId: input.guildId,
      privateTestGuildConfirmed: input.privateTestGuildConfirmed,
      voiceChannelId: input.voiceChannelId,
    }),
    runId: input.runId,
    schemaVersion: 3 as const,
    source: Object.freeze({
      codec: "opus" as const,
      craigBotId: input.craigBotId,
      decodedPcm: Object.freeze({
        channels: PCM_S16LE_CHANNELS,
        encoding: "s16le" as const,
        sampleRateHertz: PCM_S16LE_SAMPLE_RATE_HERTZ,
      }),
      receiver: "@discordjs/voice" as const,
    }),
    transcriptVerification: Object.freeze({ status: "not-run" as const }),
  });
}
