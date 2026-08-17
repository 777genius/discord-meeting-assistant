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

type GreetingFirstAudioOutcome =
  | { readonly startedAtMilliseconds: number; readonly status: "started" }
  | { readonly status: "unplayed" };

export interface ParticipantGreetingPlayback {
  readonly firstAudio: Promise<GreetingFirstAudioOutcome>;
  readonly settlement: Promise<GreetingAttemptOutcome>;
}

export async function cancelParticipantGreetingPlayback(
  configuration: LiveConversationConfiguration,
  logger: LiveRuntimeLogger,
  meetingId: string,
  participantId: string,
  nowMilliseconds: number,
): Promise<void> {
  try {
    await configuration.coordinator.participantLeft?.(
      meetingId,
      participantId,
      nowMilliseconds,
    );
  } catch (error) {
    logger.warn("Participant greeting deadline cancellation failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      meetingId,
      participantId,
      reason: "join-to-first-audio-deadline",
    });
  }
}

interface AttemptResult {
  readonly outcome: GreetingAttemptOutcome;
  readonly started: boolean;
}

export function playParticipantGreeting(
  input: ParticipantGreetingPlaybackInput,
): ParticipantGreetingPlayback {
  let firstAudioSettled = false;
  let resolveFirstAudio!: (outcome: GreetingFirstAudioOutcome) => void;
  const firstAudio = new Promise<GreetingFirstAudioOutcome>((resolve) => {
    resolveFirstAudio = (outcome) => {
      if (!firstAudioSettled) {
        firstAudioSettled = true;
        resolve(outcome);
      }
    };
  });
  const settlement = runParticipantGreeting(input, resolveFirstAudio).finally(() => {
    resolveFirstAudio({ status: "unplayed" });
  });
  return { firstAudio, settlement };
}

async function runParticipantGreeting(
  input: ParticipantGreetingPlaybackInput,
  observeFirstAudio: (outcome: GreetingFirstAudioOutcome) => void,
): Promise<GreetingAttemptOutcome> {
  try {
    const preparedCue = selectCue(input, input.greeting.prompt);
    const primary = await playAttempt(
      input,
      input.turnId,
      preparedCue,
      observeFirstAudio,
    );
    if (
      primary.outcome === "unplayed" &&
      !primary.started &&
      preparedCue === null &&
      input.isNamed
    ) {
      return playAnonymousFallback(input, observeFirstAudio);
    }
    if (primary.outcome === "played") {
      logSettled(
        input,
        preparedCue === null ? "tts-fallback" : "prepared-cue",
        input.turnId,
      );
    }
    return primary.outcome;
  } catch (error) {
    input.logger.warn("Participant greeting failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      meetingId: input.meetingId,
      participantId: input.participantId,
    });
    return "failed";
  }
}

async function playAttempt(
  input: ParticipantGreetingPlaybackInput,
  turnId: string,
  preparedCue: ReturnType<typeof selectCue>,
  observeFirstAudio: (outcome: GreetingFirstAudioOutcome) => void,
): Promise<AttemptResult> {
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
        turnId,
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
          turnId,
          voiceProfileId: input.configuration.voiceProfileId,
        });
  if (outcome.status !== "active" && outcome.status !== "queued") {
    return { outcome: outcome.status, started: false };
  }
  const start = await input.configuration.coordinator.whenTurnPlaybackStarted(
    input.meetingId,
    turnId,
  );
  if (start.status === "started") {
    observeFirstAudio({
      startedAtMilliseconds: start.startedAtMs,
      status: "started",
    });
  }
  const settlement = await input.configuration.coordinator.whenTurnPlaybackSettled(
    input.meetingId,
    turnId,
  );
  return { outcome: settlement, started: start.status === "started" };
}

async function playAnonymousFallback(
  input: ParticipantGreetingPlaybackInput,
  observeFirstAudio: (outcome: GreetingFirstAudioOutcome) => void,
): Promise<GreetingAttemptOutcome> {
  const speech = input.greeting.locale === "ru" ? "Привет!" : "Hi!";
  const preparedCue = selectCue(input, speech);
  if (preparedCue === null || input.shouldStop()) {
    return "unplayed";
  }
  const turnId = `${input.turnId}:anonymous-fallback`;
  const result = await playAttempt(input, turnId, preparedCue, observeFirstAudio);
  if (result.outcome === "played") {
    logSettled(input, "prepared-anonymous-fallback", turnId);
  }
  return result.outcome;
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
