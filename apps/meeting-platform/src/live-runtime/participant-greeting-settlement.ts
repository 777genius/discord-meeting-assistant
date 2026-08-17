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
  readonly markGreeted: () => void;
  readonly observeFirstAudio: (startedAtMilliseconds: number) => void;
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
  const firstAudio = await input.deadlines.race(
    input.participantId,
    input.playback.firstAudio,
    input.dependencies.nowMilliseconds,
  );
  if (firstAudio.status === "expired") {
    input.markGreeted();
    await cancelGreetingPlaybackBounded(input.dependencies, input.participantId);
    detachGreetingPlaybackSettlement(input.playback);
    await input.receipts.settle(input.participantId, "suppressed", "ambiguous");
    releaseAndAdvance(input);
    return { status: "terminal" };
  }
  if (firstAudio.value.status === "unplayed") {
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
    input.participantId,
    firstAudio.value.startedAtMilliseconds,
  )) {
    input.markGreeted();
    await cancelGreetingPlaybackBounded(input.dependencies, input.participantId);
    detachGreetingPlaybackSettlement(input.playback);
    await input.receipts.settle(input.participantId, "suppressed", "ambiguous");
    releaseAndAdvance(input);
    input.clearTerminal();
    return { status: "terminal" };
  }
  input.observeFirstAudio(firstAudio.value.startedAtMilliseconds);
  const outcome = await awaitGreetingPlaybackSettlement(
    input.dependencies,
    input.participantId,
    input.playback,
    input.playbackBoundMilliseconds,
  );
  releaseAndAdvance(input);
  return { outcome, status: "outcome" };
}

function releaseAndAdvance(input: CoordinateGreetingPlaybackInput): void {
  input.releaseSlot();
  input.suppressOverflow();
}

export async function cancelGreetingPlaybackBounded(
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

export async function awaitGreetingPlaybackSettlement(
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

export function detachGreetingPlaybackSettlement(
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
