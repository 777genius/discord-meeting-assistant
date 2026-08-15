import type {
  LiveConversationConfiguration,
  LiveRuntimeLogger,
} from "./contracts.js";
import {
  exactGreetingSystemPrompt,
  type GreetingAttemptOutcome,
  type ResolvedParticipantGreeting,
} from "./participant-greeting-content.js";

interface ParticipantGreetingPlaybackInput {
  readonly configuration: LiveConversationConfiguration;
  readonly greeting: ResolvedParticipantGreeting;
  readonly isNamed: boolean;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly nowMilliseconds: () => number;
  readonly observedLatencyMilliseconds: () => number;
  readonly participantId: string;
  readonly shouldStop: () => boolean;
  readonly turnId: string;
}

export async function playParticipantGreeting(
  input: ParticipantGreetingPlaybackInput,
): Promise<GreetingAttemptOutcome> {
  try {
    const preparedCue = selectCue(input, input.greeting.prompt);
    const outcome = preparedCue === null
      ? await input.configuration.coordinator.handleProactiveTurn({
          interruptible: false,
          locale: input.greeting.locale,
          literalSpeech: input.greeting.prompt,
          meetingId: input.meetingId,
          nowMs: input.nowMilliseconds(),
          prompt: input.greeting.prompt,
          recordingId: input.meetingId,
          speakerId: input.participantId,
          systemPrompt: exactGreetingSystemPrompt,
          turnId: input.turnId,
          voiceProfileId: input.configuration.voiceProfileId,
        })
      : await input.configuration.coordinator.playPreparedCue({
          ...(preparedCue.assetSha256 === undefined
            ? {}
            : { assetSha256: preparedCue.assetSha256 }),
          cueId: preparedCue.cueId,
          interruptible: false,
          locale: input.greeting.locale,
          meetingId: input.meetingId,
          nowMs: input.nowMilliseconds(),
          pcmChunks: preparedCue.pcmChunks,
          playbackAttemptId: preparedCue.playbackAttemptId,
          preemptive: false,
          recordingId: input.meetingId,
          speakerId: input.participantId,
          turnId: input.turnId,
          voiceProfileId: input.configuration.voiceProfileId,
        });
    if (outcome.status !== "active" && outcome.status !== "queued") {
      return outcome.status;
    }
    const settlement = await input.configuration.coordinator.whenTurnPlaybackSettled(
      input.meetingId,
      input.turnId,
    );
    if (settlement === "unplayed" && preparedCue === null && input.isNamed) {
      return playAnonymousFallback(input);
    }
    if (settlement === "played") {
      logSettled(input, preparedCue === null ? "tts-fallback" : "prepared-cue", input.turnId);
    }
    return settlement;
  } catch (error) {
    input.logger.warn("Participant greeting failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      meetingId: input.meetingId,
      participantId: input.participantId,
    });
    return "failed";
  }
}

async function playAnonymousFallback(
  input: ParticipantGreetingPlaybackInput,
): Promise<GreetingAttemptOutcome> {
  const speech = input.greeting.locale === "ru" ? "Привет!" : "Hi!";
  const preparedCue = selectCue(input, speech);
  if (preparedCue === null || input.shouldStop()) {
    return "unplayed";
  }
  const turnId = `${input.turnId}:anonymous-fallback`;
  const outcome = await input.configuration.coordinator.playPreparedCue({
    ...(preparedCue.assetSha256 === undefined
      ? {}
      : { assetSha256: preparedCue.assetSha256 }),
    cueId: preparedCue.cueId,
    interruptible: false,
    locale: input.greeting.locale,
    meetingId: input.meetingId,
    nowMs: input.nowMilliseconds(),
    pcmChunks: preparedCue.pcmChunks,
    playbackAttemptId: preparedCue.playbackAttemptId,
    preemptive: false,
    recordingId: input.meetingId,
    speakerId: input.participantId,
    turnId,
    voiceProfileId: input.configuration.voiceProfileId,
  });
  if (outcome.status !== "active" && outcome.status !== "queued") {
    return outcome.status;
  }
  const settlement = await input.configuration.coordinator.whenTurnPlaybackSettled(
    input.meetingId,
    turnId,
  );
  if (settlement === "played") {
    logSettled(input, "prepared-anonymous-fallback", turnId);
  }
  return settlement;
}

function selectCue(input: ParticipantGreetingPlaybackInput, speech: string) {
  return input.configuration.greetings?.cues?.select({
    locale: input.greeting.locale,
    meetingId: input.meetingId,
    participantId: input.participantId,
    speech,
    voiceProfileId: input.configuration.voiceProfileId,
  }) ?? null;
}

function logSettled(
  input: ParticipantGreetingPlaybackInput,
  playbackMode: "prepared-anonymous-fallback" | "prepared-cue" | "tts-fallback",
  turnId: string,
): void {
  input.logger.info("Participant greeting playback settled", {
    greetingLocale: input.greeting.locale,
    meetingId: input.meetingId,
    participantId: input.participantId,
    participantNameStatus: input.isNamed ? "known" : "unknown",
    playbackMode,
    observedJoinToPlaybackSettledMs: input.observedLatencyMilliseconds(),
    turnId,
  });
}
