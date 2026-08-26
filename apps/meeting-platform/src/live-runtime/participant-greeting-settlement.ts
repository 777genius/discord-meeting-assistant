import type { GreetingAttemptOutcome } from "./participant-greeting-content.js";
import type { ParticipantGreetingDeadlines } from "./participant-greeting-deadline.js";
import {
  cancelParticipantGreetingPlayback,
  type ParticipantGreetingPlayback,
} from "./participant-greeting-playback.js";
import type {
  LiveConversationConfiguration,
  LiveRuntimeLogger,
  LiveRuntimeTimer,
} from "./contracts.js";
import type { ParticipantGreetingReceipts } from "./participant-greeting-receipts.js";

const playbackCancellationMarginMilliseconds = 250;
const playbackSettlementMarginMilliseconds = 250;
const providerStartPersistenceAttempts = 3;
export const participantGreetingSettlementSlotMarginMilliseconds =
  playbackCancellationMarginMilliseconds + playbackSettlementMarginMilliseconds;

interface GreetingSettlementDependencies {
  readonly configuration: LiveConversationConfiguration;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly nowMilliseconds: () => number;
  readonly timer: LiveRuntimeTimer;
}

interface CoordinateGreetingPlaybackInput {
  readonly clearTerminal: () => void;
  readonly deadlines: ParticipantGreetingDeadlines;
  readonly dependencies: GreetingSettlementDependencies;
  /** Earliest producer deadline represented by this command. */
  readonly deadlineParticipantId?: string;
  readonly markGreeted: () => void;
  readonly observeFirstAudio: (startedAtMilliseconds: number) => void;
  readonly persistFirstAudio: (startedAtMilliseconds: number) => Promise<void>;
  readonly participantId: string;
  readonly playback: ParticipantGreetingPlayback;
  readonly playbackBoundMilliseconds: number;
  readonly receipts: ParticipantGreetingReceipts;
  readonly releaseSlot: () => void;
  readonly suppressOverflow: () => void;
}

export type CoordinatedGreetingPlayback =
  | { readonly outcome: GreetingAttemptOutcome; readonly status: "outcome" }
  | { readonly status: "terminal" };

export async function coordinateGreetingPlayback(
  input: CoordinateGreetingPlaybackInput,
): Promise<CoordinatedGreetingPlayback> {
  const deadlineParticipantId = input.deadlineParticipantId ?? input.participantId;
  const firstAudioResult = await input.deadlines.race(
    deadlineParticipantId,
    input.playback.firstAudio,
    input.dependencies.nowMilliseconds,
  );
  if (firstAudioResult.status === "expired") {
    await cancelGreetingPlaybackBounded(input.dependencies, input.participantId);
    detachGreetingPlaybackSettlement(input.playback);
    await input.receipts.settle(input.participantId, "suppressed", "stale");
    input.markGreeted();
    input.clearTerminal();
    releaseAndAdvance(input);
    return { status: "terminal" };
  }
  const firstAudio = firstAudioResult.value;
  if (firstAudio.status === "unplayed") {
    const outcome = await awaitGreetingPlaybackSettlement(
      input.dependencies,
      input.participantId,
      input.playback,
      input.playbackBoundMilliseconds,
    );
    releaseAndAdvance(input);
    if (outcome !== "played") {
      return { outcome, status: "outcome" };
    }
    await input.receipts.settle(input.participantId, "suppressed", "ambiguous");
    input.markGreeted();
    input.clearTerminal();
    return { status: "terminal" };
  }
  if (!input.deadlines.acceptFirstAudio(
    deadlineParticipantId,
    firstAudio.startedAtMilliseconds,
  )) {
    input.markGreeted();
    await cancelGreetingPlaybackBounded(input.dependencies, input.participantId);
    detachGreetingPlaybackSettlement(input.playback);
    await input.receipts.settle(input.participantId, "suppressed", "ambiguous");
    releaseAndAdvance(input);
    input.clearTerminal();
    return { status: "terminal" };
  }
  try {
    await persistProviderStart(input, firstAudio.startedAtMilliseconds);
  } catch (error) {
    input.dependencies.logger.error("Greeting provider start attestation retries exhausted", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      meetingId: input.dependencies.meetingId,
      participantId: input.participantId,
      reason: "provider-start-attestation-failed",
    });
    await cancelGreetingPlaybackBounded(input.dependencies, input.participantId);
    detachGreetingPlaybackSettlement(input.playback);
    await input.receipts.settle(input.participantId, "suppressed", "ambiguous");
    input.markGreeted();
    input.clearTerminal();
    releaseAndAdvance(input);
    return { status: "terminal" };
  }
  input.observeFirstAudio(firstAudio.startedAtMilliseconds);
  const outcome = await awaitGreetingPlaybackSettlement(
    input.dependencies,
    input.participantId,
    input.playback,
    input.playbackBoundMilliseconds,
  );
  releaseAndAdvance(input);
  return { outcome, status: "outcome" };
}

async function persistProviderStart(
  input: CoordinateGreetingPlaybackInput,
  startedAtMilliseconds: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= providerStartPersistenceAttempts; attempt += 1) {
    try {
      await input.persistFirstAudio(startedAtMilliseconds);
      return;
    } catch (error) {
      lastError = error;
      input.dependencies.logger.warn("Greeting provider start persistence will retry", {
        attempt,
        errorName: error instanceof Error ? error.name : "UnknownError",
        meetingId: input.dependencies.meetingId,
        participantId: input.participantId,
        reason: "provider-start-attestation-failed",
      });
    }
  }
  throw lastError;
}

function releaseAndAdvance(input: CoordinateGreetingPlaybackInput): void {
  input.releaseSlot();
  input.suppressOverflow();
}

async function cancelGreetingPlaybackBounded(
  dependencies: GreetingSettlementDependencies,
  participantId: string,
): Promise<void> {
  const cancellation = cancelParticipantGreetingPlayback(
    dependencies.configuration,
    dependencies.logger,
    dependencies.meetingId,
    participantId,
    dependencies.nowMilliseconds(),
  );
  await raceWithTimer(
    dependencies.timer,
    cancellation,
    playbackCancellationMarginMilliseconds,
  );
  void cancellation.catch(() => {});
}

async function awaitGreetingPlaybackSettlement(
  dependencies: GreetingSettlementDependencies,
  participantId: string,
  playback: ParticipantGreetingPlayback,
  playbackBoundMilliseconds: number,
): Promise<GreetingAttemptOutcome> {
  const settlement = playback.settlement.then((outcome) => ({ outcome }));
  const result = await raceWithTimer(
    dependencies.timer,
    settlement,
    playbackBoundMilliseconds + playbackSettlementMarginMilliseconds,
  );
  if (result !== null) {
    return result.outcome;
  }
  await cancelGreetingPlaybackBounded(dependencies, participantId);
  detachGreetingPlaybackSettlement(playback);
  dependencies.logger.warn("Participant greeting settlement exceeded playback bound", {
    meetingId: dependencies.meetingId,
    participantId,
    playbackBoundMilliseconds,
  });
  return "failed";
}

function detachGreetingPlaybackSettlement(
  playback: ParticipantGreetingPlayback,
): void {
  // Cancellation and recovery cannot wait for a late or missing provider receipt.
  void playback.settlement.catch(() => {});
}

async function raceWithTimer<T>(
  timer: LiveRuntimeTimer,
  operation: Promise<T>,
  delayMilliseconds: number,
): Promise<T | null> {
  let handle: ReturnType<LiveRuntimeTimer["schedule"]> | undefined;
  const timeout = new Promise<null>((resolve) => {
    handle = timer.schedule(delayMilliseconds, () => {
      resolve(null);
    });
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (handle !== undefined) {
      timer.cancel(handle);
    }
  });
}
