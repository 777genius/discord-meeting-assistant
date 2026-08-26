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
  readonly fallbackPreparedCue: ParticipantGreetingPreparedCue | null;
  readonly greeting: ResolvedParticipantGreeting;
  readonly isNamed: boolean;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly nowMilliseconds: () => number;
  readonly observedLatencyMilliseconds: () => number;
  readonly participantId: string;
  readonly providerCommandId: string;
  readonly preparedCue: ParticipantGreetingPreparedCue | null;
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

export interface ParticipantGreetingPreparedCue {
  readonly assetSha256?: string;
  readonly cueId: string;
  readonly pcmChunks: readonly Uint8Array[];
  readonly playbackAttemptId: string;
}

const pcmBytesPerMillisecond = 48_000 * 2 / 1_000;
const maximumLiteralGreetingPlaybackMilliseconds = 2_500;

/** Conservative single-slot playback bound used before any provider side effect. */
export function participantGreetingPlaybackBoundMilliseconds(
  preparedCue: ParticipantGreetingPreparedCue | null,
): number {
  if (preparedCue === null) {
    return maximumLiteralGreetingPlaybackMilliseconds;
  }
  const bytes = preparedCue.pcmChunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    return maximumLiteralGreetingPlaybackMilliseconds;
  }
  return Math.max(1, Math.ceil(bytes / pcmBytesPerMillisecond));
}

export function selectParticipantGreetingPreparedCue(
  configuration: LiveConversationConfiguration,
  greeting: ResolvedParticipantGreeting,
  meetingId: string,
  participantId: string,
): ParticipantGreetingPreparedCue | null {
  return configuration.greetings?.cues?.select({
    locale: greeting.locale,
    meetingId,
    participantId,
    speech: greeting.prompt,
    voiceProfileId: configuration.voiceProfileId,
  }) ?? null;
}

export function selectParticipantGreetingAnonymousCue(
  configuration: LiveConversationConfiguration,
  locale: "en" | "ru",
  meetingId: string,
  participantId: string,
): ParticipantGreetingPreparedCue | null {
  return selectParticipantGreetingPreparedCue(
    configuration,
    { locale, prompt: locale === "ru" ? "Привет!" : "Hi!" },
    meetingId,
    participantId,
  );
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
    const preparedCue = input.preparedCue;
    const primary = await playAttempt(
      input,
      input.turnId,
      preparedCue,
      observeFirstAudio,
    );
    if (!primary.started &&
      (primary.outcome === "failed" || primary.outcome === "unplayed")) {
      if (preparedCue !== null || input.fallbackPreparedCue === null) {
        observeFirstAudio({ status: "unplayed" });
        return "unplayed";
      }
      const fallbackTurnId = `${input.turnId}:anonymous-fallback`;
      const fallback = await playAttempt(
        input,
        fallbackTurnId,
        input.fallbackPreparedCue,
        observeFirstAudio,
      );
      if (!fallback.started) {
        observeFirstAudio({ status: "unplayed" });
      }
      if (fallback.outcome === "played") {
        logSettled(input, "prepared-anonymous-fallback", fallbackTurnId);
      }
      return fallback.outcome;
    }
    if (!primary.started) {
      observeFirstAudio({ status: "unplayed" });
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
  preparedCue: ParticipantGreetingPreparedCue | null,
  observeFirstAudio: (outcome: GreetingFirstAudioOutcome) => void,
): Promise<AttemptResult> {
  const outcome = preparedCue === null
    ? await input.configuration.coordinator.handleProactiveTurn({
        interruptible: false,
        locale: input.greeting.locale,
        literalSpeech: input.greeting.prompt,
        meetingId: input.meetingId,
        nowMs: input.nowMilliseconds(),
        playbackAttemptId: input.providerCommandId,
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
          // The durable receipt owns this command identity. Reusing a cue-registry
          // attempt id here would make crash recovery issue a different command.
          playbackAttemptId: input.providerCommandId,
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
