import type { LiveConversationConfiguration, LiveRuntimeLogger } from "./contracts.js";
import type {
  GreetingAttemptOutcome,
  ResolvedParticipantGreeting,
} from "./participant-greeting-content.js";
import type { ParticipantGreetingDeadlines } from "./participant-greeting-deadline.js";
import {
  ParticipantGreetingQueue,
  type ParticipantGreetingPriority,
} from "./participant-greeting-queue.js";
import {
  participantGreetingPlaybackBoundMilliseconds,
  selectParticipantGreetingPreparedCue,
  type ParticipantGreetingPreparedCue,
} from "./participant-greeting-playback.js";
import { participantGreetingSettlementSlotMarginMilliseconds } from
  "./participant-greeting-settlement.js";
import type { ParticipantGreetingReceipts } from "./participant-greeting-receipts.js";

const maximumFirstAudioStartupMilliseconds = 750;
const maximumSafeRetries = 3;
/** One bounded small-call command may finish after the five-second first-audio deadline. */
const maximumCohortPlaybackMilliseconds = 45_000;

interface GreetingSchedulingDependencies {
  readonly configuration: LiveConversationConfiguration;
  readonly meetingId: string;
}

interface GreetingReservationInput {
  readonly clearTerminal: () => void;
  readonly deadlines: ParticipantGreetingDeadlines;
  readonly markGreeted: () => void;
  readonly nowMilliseconds: () => number;
  readonly participantId: string;
  readonly receipts: ParticipantGreetingReceipts;
  readonly reclaimActive?: boolean;
}

interface GreetingOutcomeInput {
  readonly clearTerminal: () => void;
  readonly deadlines: ParticipantGreetingDeadlines;
  readonly isPresent: () => boolean;
  readonly logger: LiveRuntimeLogger;
  readonly markGreeted: () => void;
  readonly meetingId: string;
  readonly nowMilliseconds: () => number;
  readonly outcome: GreetingAttemptOutcome;
  readonly participantId: string;
  readonly pendingGreetings: ParticipantGreetingQueue;
  readonly priority: ParticipantGreetingPriority;
  readonly receipts: ParticipantGreetingReceipts;
}

export interface GreetingPlaybackAdmission {
  readonly leaseToken: string;
  readonly providerCommand?: { readonly locale: "en" | "ru"; readonly prompt: string };
  readonly providerCommandId: string;
  readonly providerRecoveryDeadlineMilliseconds?: number;
}

export async function reserveGreetingPlaybackAdmission(
  input: GreetingReservationInput,
): Promise<GreetingPlaybackAdmission | undefined> {
  if (input.reclaimActive === true) {
    const recovered = await input.receipts.reserve(input.participantId, true);
    if (recovered.status !== "reserved") {
      input.markGreeted();
      input.clearTerminal();
      return undefined;
    }
    if (recovered.providerCommand === undefined) {
      if (!input.deadlines.ensureFresh(input.participantId, input.nowMilliseconds())) {
        await input.receipts.settle(input.participantId, "suppressed", "stale");
        input.markGreeted();
        input.clearTerminal();
        return undefined;
      }
      return {
        leaseToken: recovered.leaseToken,
        providerCommandId: recovered.providerCommandId ??
          `participant-greeting:${input.participantId}`,
      };
    }
    if (recovered.providerRecoveryRemainingMilliseconds === undefined ||
      recovered.providerRecoveryRemainingMilliseconds <= 0) {
      await input.receipts.settle(input.participantId, "suppressed", "ambiguous");
      input.markGreeted();
      input.clearTerminal();
      return undefined;
    }
    return {
      leaseToken: recovered.leaseToken,
      providerCommand: recovered.providerCommand,
      providerCommandId: recovered.providerCommandId ??
        `participant-greeting:${input.participantId}`,
      providerRecoveryDeadlineMilliseconds: input.nowMilliseconds() +
        recovered.providerRecoveryRemainingMilliseconds,
    };
  }
  if (!input.deadlines.ensureFresh(input.participantId, input.nowMilliseconds())) {
    await input.receipts.fenceOnce(input.participantId);
    return undefined;
  }
  const reservation = input.receipts.reserve(
    input.participantId,
    false,
  );
  const result = await input.deadlines.race(
    input.participantId,
    reservation,
    input.nowMilliseconds,
  );
  if (result.status === "expired") {
    input.markGreeted();
    input.deadlines.track(input.receipts.settleExpiredReservation(
      input.participantId,
      result.operation,
    ));
    return undefined;
  }
  if (result.value.status !== "reserved") {
    input.markGreeted();
    input.clearTerminal();
    return undefined;
  }
  return {
    leaseToken: result.value.leaseToken,
    ...(result.value.providerCommand === undefined
      ? {}
      : { providerCommand: result.value.providerCommand }),
    ...(result.value.providerRecoveryRemainingMilliseconds === undefined
      ? {}
      : { providerRecoveryDeadlineMilliseconds:
          input.nowMilliseconds() + result.value.providerRecoveryRemainingMilliseconds }),
    providerCommandId: result.value.providerCommandId ??
      `participant-greeting:${input.participantId}`,
  };
}

/** Owns conservative sequential slots before any durable/provider attempt. */
export class ParticipantGreetingScheduling {
  private activeSlotUntilMilliseconds = 0;
  private readonly playbackBoundsMilliseconds = new Map<string, number>();
  private readonly preparedCues = new Map<string, ParticipantGreetingPreparedCue | null>();
  private readonly retryCounts = new Map<string, number>();

  public constructor(private readonly dependencies: GreetingSchedulingDependencies) {}

  public plan(
    participantId: string,
    greeting: ResolvedParticipantGreeting,
  ): void {
    const preparedCue = selectParticipantGreetingPreparedCue(
      this.dependencies.configuration,
      greeting,
      this.dependencies.meetingId,
      participantId,
    );
    this.preparedCues.set(participantId, preparedCue);
    this.playbackBoundsMilliseconds.set(
      participantId,
      participantGreetingPlaybackBoundMilliseconds(preparedCue),
    );
  }

  public forget(participantId: string): void {
    this.playbackBoundsMilliseconds.delete(participantId);
    this.preparedCues.delete(participantId);
    this.retryCounts.delete(participantId);
  }

  public clear(): void {
    this.activeSlotUntilMilliseconds = 0;
    this.playbackBoundsMilliseconds.clear();
    this.preparedCues.clear();
    this.retryCounts.clear();
  }

  public preparedCue(participantId: string): ParticipantGreetingPreparedCue | null {
    return this.preparedCues.get(participantId) ?? null;
  }

  public retryCount(participantId: string): number {
    return this.retryCounts.get(participantId) ?? 0;
  }

  public async settleOutcome(input: GreetingOutcomeInput): Promise<boolean> {
    if (input.outcome === "busy" || input.outcome === "unplayed") {
      const retryCount = this.retryCount(input.participantId) + 1;
      this.retryCounts.set(input.participantId, retryCount);
      if (
        retryCount <= maximumSafeRetries && input.isPresent() &&
        input.deadlines.ensureFresh(input.participantId, input.nowMilliseconds())
      ) {
        await input.receipts.release(input.participantId, input.outcome);
        input.pendingGreetings.deferRetry(input.participantId, input.priority);
        return true;
      }
      await input.receipts.settle(input.participantId, "suppressed", "ambiguous");
      input.logger.warn("Participant greeting retries exhausted", {
        meetingId: input.meetingId,
        participantId: input.participantId,
      });
    } else if (input.outcome === "played") {
      await input.receipts.settle(input.participantId, "played");
    } else {
      await input.receipts.settle(input.participantId, "suppressed", "ambiguous");
    }
    input.markGreeted();
    input.clearTerminal();
    return false;
  }

  public beginSlot(
    participantId: string,
    nowMilliseconds: number,
    dynamicCohort = false,
  ): number {
    const playbackBound = dynamicCohort
      ? maximumCohortPlaybackMilliseconds
      : this.playbackBoundsMilliseconds.get(participantId) ??
        participantGreetingPlaybackBoundMilliseconds(null);
    this.activeSlotUntilMilliseconds = nowMilliseconds +
      maximumFirstAudioStartupMilliseconds + playbackBound +
      participantGreetingSettlementSlotMarginMilliseconds;
    return playbackBound;
  }

  public observeFirstAudio(
    startedAtMilliseconds: number,
    playbackBoundMilliseconds: number,
  ): void {
    this.activeSlotUntilMilliseconds = startedAtMilliseconds +
      playbackBoundMilliseconds + participantGreetingSettlementSlotMarginMilliseconds;
  }

  public releaseSlot(): void {
    this.activeSlotUntilMilliseconds = 0;
  }

  public canStartBeforeDeadline(
    expiresAtMilliseconds: number | undefined,
    nowMilliseconds: number,
  ): boolean {
    return expiresAtMilliseconds !== undefined &&
      nowMilliseconds + maximumFirstAudioStartupMilliseconds < expiresAtMilliseconds;
  }

}
