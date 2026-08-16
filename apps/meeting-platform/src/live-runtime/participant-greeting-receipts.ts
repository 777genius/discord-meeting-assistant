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

  public async commit(participantId: string, leaseToken: string): Promise<void> {
    const completed = this.dependencies.port?.complete({
      kind: "greeting",
      leaseToken,
      meetingId: this.dependencies.meetingId,
      subjectId: participantId,
    }) ?? Promise.resolve();
    try {
      await completed;
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
        await this.commit(participantId, receipt.leaseToken);
      }
    } catch {
      await this.fenceOnce(participantId);
    }
  }

  private async fence(participantId: string): Promise<void> {
    try {
      const receipt = await this.reserve(participantId);
      if (receipt.status === "reserved") {
        await this.commit(participantId, receipt.leaseToken);
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
