import type {
  LiveConversationOneShotReceiptPort,
  LiveConversationOneShotReceiptReservation,
  LiveRuntimeLogger,
} from "./contracts.js";
import { participantGreetingDeadlineReason } from "./participant-greeting-deadline.js";

const oneShotReceiptLeaseSeconds = 120;

interface ParticipantGreetingReceiptDependencies {
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly port?: LiveConversationOneShotReceiptPort;
}

/** Owns durable and meeting-local greeting playback admission fences. */
export class ParticipantGreetingReceipts {
  private readonly activeLeaseTokens = new Map<string, string>();
  private readonly completedParticipantIds = new Set<string>();
  private readonly fencingTasks = new Map<string, Promise<void>>();
  private readonly legacyCompletedParticipantIds = new Set<string>();
  private readonly reservationInProgressParticipantIds = new Set<string>();
  private readonly reservedParticipantIds = new Set<string>();

  public constructor(private readonly dependencies: ParticipantGreetingReceiptDependencies) {}

  public isFencedOrActive(participantId: string): boolean {
    return this.completedParticipantIds.has(participantId) ||
      this.activeLeaseTokens.has(participantId) ||
      this.reservationInProgressParticipantIds.has(participantId);
  }

  public reserve(participantId: string): Promise<LiveConversationOneShotReceiptReservation> {
    this.reservationInProgressParticipantIds.add(participantId);
    const operation = this.reserveUntracked(participantId).then((receipt) => {
      if (receipt.status === "reserved") {
        this.activeLeaseTokens.set(participantId, receipt.leaseToken);
      }
      return receipt;
    });
    void operation.finally(() => {
      this.reservationInProgressParticipantIds.delete(participantId);
    }).catch(() => {});
    return operation;
  }

  public async beginAttempt(participantId: string, leaseToken: string): Promise<void> {
    const port = this.dependencies.port;
    try {
      if (port === undefined) {
        return;
      }
      if (port.beginGreetingAttempt !== undefined) {
        await port.beginGreetingAttempt({
          kind: "greeting",
          leaseToken,
          meetingId: this.dependencies.meetingId,
          subjectId: participantId,
        });
        return;
      }
      await port?.complete({
        kind: "greeting",
        leaseToken,
        meetingId: this.dependencies.meetingId,
        subjectId: participantId,
      });
      this.legacyCompletedParticipantIds.add(participantId);
      this.completedParticipantIds.add(participantId);
      this.activeLeaseTokens.delete(participantId);
      this.reservedParticipantIds.delete(participantId);
    } catch (error) {
      this.activeLeaseTokens.delete(participantId);
      this.reservedParticipantIds.delete(participantId);
      throw error;
    }
  }

  public async release(participantId: string, evidence: "busy" | "unplayed"): Promise<void> {
    const leaseToken = this.activeLeaseTokens.get(participantId);
    if (leaseToken === undefined) {
      return;
    }
    try {
      const port = this.dependencies.port;
      if (port?.releaseGreetingAttempt !== undefined) {
        await port.releaseGreetingAttempt({
          evidence,
          kind: "greeting",
          leaseToken,
          meetingId: this.dependencies.meetingId,
          subjectId: participantId,
        });
      } else {
        await port?.release({
          kind: "greeting",
          leaseToken,
          meetingId: this.dependencies.meetingId,
          subjectId: participantId,
        });
      }
    } finally {
      this.activeLeaseTokens.delete(participantId);
      this.reservedParticipantIds.delete(participantId);
    }
  }

  public async settle(
    participantId: string,
    outcome: "played" | "suppressed",
    reason?: "ambiguous" | "stale",
  ): Promise<void> {
    if (this.legacyCompletedParticipantIds.has(participantId)) {
      return;
    }
    const leaseToken = this.activeLeaseTokens.get(participantId);
    if (leaseToken === undefined) {
      return;
    }
    const port = this.dependencies.port;
    const settlement = port?.settleGreeting?.({
      kind: "greeting",
      leaseToken,
      meetingId: this.dependencies.meetingId,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      subjectId: participantId,
    }) ?? port?.complete({
      kind: "greeting",
      leaseToken,
      meetingId: this.dependencies.meetingId,
      subjectId: participantId,
    }) ?? Promise.resolve();
    try {
      await settlement;
      this.completedParticipantIds.add(participantId);
    } finally {
      this.activeLeaseTokens.delete(participantId);
      this.reservedParticipantIds.delete(participantId);
    }
  }

  public fenceOnce(participantId: string): Promise<void> {
    const active = this.fencingTasks.get(participantId);
    if (active !== undefined) {
      return active;
    }
    const task = this.fence(participantId).finally(() => {
      if (this.fencingTasks.get(participantId) === task) {
        this.fencingTasks.delete(participantId);
      }
    });
    this.fencingTasks.set(participantId, task);
    return task;
  }

  public async settleExpiredReservation(
    participantId: string,
    reservation: Promise<LiveConversationOneShotReceiptReservation>,
  ): Promise<void> {
    try {
      const receipt = await reservation;
      if (receipt.status === "reserved") {
        await this.settle(participantId, "suppressed", "stale");
      }
    } catch {
      await this.fenceOnce(participantId);
    }
  }

  private async fence(participantId: string): Promise<void> {
    try {
      const receipt = await this.reserve(participantId);
      if (receipt.status === "reserved") {
        await this.settle(participantId, "suppressed", "stale");
      }
    } catch (error) {
      this.dependencies.logger.warn("Participant greeting deadline settlement failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        meetingId: this.dependencies.meetingId,
        participantId,
        reason: participantGreetingDeadlineReason,
      });
    }
  }

  private reserveUntracked(
    participantId: string,
  ): Promise<LiveConversationOneShotReceiptReservation> {
    if (this.dependencies.port === undefined) {
      if (this.completedParticipantIds.has(participantId)) {
        return Promise.resolve({ status: "completed" });
      }
      if (this.reservedParticipantIds.has(participantId)) {
        return Promise.resolve({ status: "in_flight" });
      }
      this.reservedParticipantIds.add(participantId);
      return Promise.resolve({
        leaseToken: `meeting-local-greeting:${participantId}`,
        status: "reserved",
      });
    }
    return this.dependencies.port.reserve({
      kind: "greeting",
      leaseSeconds: oneShotReceiptLeaseSeconds,
      meetingId: this.dependencies.meetingId,
      subjectId: participantId,
    });
  }
}
