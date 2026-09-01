import type {
  LiveConversationGreetingCapacityReconciliation,
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
  private readonly activeProviderCommandIds = new Map<string, string>();
  private readonly completedParticipantIds = new Set<string>();
  private readonly fencingTasks = new Map<string, Promise<void>>();
  /** Unknown command commits are reclaimed only with the same stable command. */
  private readonly recoveryRequiredParticipantIds = new Set<string>();
  private readonly reservationInProgressParticipantIds = new Set<string>();
  private readonly reservedParticipantIds = new Set<string>();

  public constructor(private readonly dependencies: ParticipantGreetingReceiptDependencies) {
    if (dependencies.port !== undefined &&
      (dependencies.port.beginGreetingAttempt === undefined ||
        dependencies.port.beginGreetingCohortAttempt === undefined ||
        dependencies.port.confirmGreetingStarted === undefined ||
        dependencies.port.confirmGreetingCohortStarted === undefined ||
        dependencies.port.settleGreeting === undefined)) {
      throw new Error("Greeting activation requires durable commanded/started/settled receipts");
    }
  }

  public isFencedOrActive(participantId: string): boolean {
    return this.completedParticipantIds.has(participantId) ||
      this.activeLeaseTokens.has(participantId) ||
      this.reservationInProgressParticipantIds.has(participantId);
  }

  public reserve(
    participantId: string,
    reclaimActive = false,
  ): Promise<LiveConversationOneShotReceiptReservation> {
    this.reservationInProgressParticipantIds.add(participantId);
    const recover = reclaimActive || this.recoveryRequiredParticipantIds.has(participantId);
    const operation = this.reserveUntracked(participantId, recover).then((receipt) => {
      if (receipt.status === "reserved") {
        this.recoveryRequiredParticipantIds.delete(participantId);
        this.activeLeaseTokens.set(participantId, receipt.leaseToken);
        this.activeProviderCommandIds.set(
          participantId,
          receipt.providerCommandId ?? `participant-greeting:${participantId}`,
        );
      } else if (receipt.status === "completed") {
        this.completedParticipantIds.add(participantId);
        this.recoveryRequiredParticipantIds.delete(participantId);
      }
      return receipt;
    });
    void operation.finally(() => {
      this.reservationInProgressParticipantIds.delete(participantId);
    }).catch(() => {});
    return operation;
  }

  public providerCommandId(participantId: string): string {
    return this.activeProviderCommandIds.get(participantId) ??
      `participant-greeting:${participantId}`;
  }

  public hasTerminalEvidence(participantId: string): boolean {
    return this.completedParticipantIds.has(participantId);
  }

  public async beginAttempt(
    participantId: string,
    leaseToken: string,
    command: { readonly locale: "en" | "ru"; readonly prompt: string },
    providerCommandId = this.providerCommandId(participantId),
  ): Promise<void> {
    const port = this.dependencies.port;
    try {
      if (port === undefined) {
        return;
      }
      if (port.beginGreetingAttempt === undefined ||
        port.confirmGreetingStarted === undefined) {
        throw new Error("Greeting activation requires commanded/started receipt transitions");
      }
      await port.beginGreetingAttempt({
        kind: "greeting",
        leaseToken,
        locale: command.locale,
        meetingId: this.dependencies.meetingId,
        prompt: command.prompt,
        providerCommandId,
        subjectId: participantId,
      });
      this.activeProviderCommandIds.set(participantId, providerCommandId);
    } catch (error) {
      this.recoveryRequiredParticipantIds.add(participantId);
      this.activeLeaseTokens.delete(participantId);
      this.activeProviderCommandIds.delete(participantId);
      this.reservedParticipantIds.delete(participantId);
      throw error;
    }
  }

  public async beginCohortAttempt(
    participantIds: readonly string[],
    command: { readonly locale: "en" | "ru"; readonly prompt: string },
    providerCommandId: string,
  ): Promise<void> {
    if (participantIds.length === 1) {
      const participantId = participantIds[0]!;
      const leaseToken = this.activeLeaseTokens.get(participantId);
      if (leaseToken === undefined) {
        throw new Error("Greeting command lost its reservation");
      }
      await this.beginAttempt(participantId, leaseToken, command, providerCommandId);
      return;
    }
    const port = this.dependencies.port;
    if (port === undefined) {
      return;
    }
    if (port.beginGreetingCohortAttempt === undefined) {
      throw new Error("Greeting receipt store cannot atomically bind cohort command");
    }
    const receipts = participantIds.map((subjectId) => {
      const leaseToken = this.activeLeaseTokens.get(subjectId);
      if (leaseToken === undefined) {
        throw new Error("Greeting cohort reservation was lost");
      }
      return { leaseToken, subjectId };
    });
    try {
      await port.beginGreetingCohortAttempt({
        kind: "greeting",
        locale: command.locale,
        meetingId: this.dependencies.meetingId,
        prompt: command.prompt,
        providerCommandId,
        receipts,
      });
    } catch (error) {
      for (const participantId of participantIds) {
        this.recoveryRequiredParticipantIds.add(participantId);
        this.activeLeaseTokens.delete(participantId);
        this.activeProviderCommandIds.delete(participantId);
        this.reservedParticipantIds.delete(participantId);
      }
      throw error;
    }
    for (const participantId of participantIds) {
      this.activeProviderCommandIds.set(participantId, providerCommandId);
    }
  }

  public async confirmStarted(participantId: string, startedAtMilliseconds: number): Promise<void> {
    const leaseToken = this.activeLeaseTokens.get(participantId);
    const port = this.dependencies.port;
    if (leaseToken === undefined || port?.confirmGreetingStarted === undefined) {
      if (port !== undefined && port.beginGreetingAttempt !== undefined) {
        throw new Error("Greeting receipt store cannot persist provider start attestation");
      }
      return;
    }
    await port.confirmGreetingStarted({
      kind: "greeting",
      leaseToken,
      meetingId: this.dependencies.meetingId,
      providerCommandId: this.providerCommandId(participantId),
      startedAtMilliseconds,
      subjectId: participantId,
    });
  }

  public async confirmCohortStarted(
    participantIds: readonly string[],
    startedAtMilliseconds: number,
  ): Promise<void> {
    if (participantIds.length === 1) {
      await this.confirmStarted(participantIds[0]!, startedAtMilliseconds);
      return;
    }
    const port = this.dependencies.port;
    if (port === undefined) {
      return;
    }
    if (port.confirmGreetingCohortStarted === undefined) {
      throw new Error("Greeting receipt store cannot atomically persist cohort start");
    }
    const providerCommandId = this.providerCommandId(participantIds[0]!);
    const receipts = participantIds.map((subjectId) => {
      const leaseToken = this.activeLeaseTokens.get(subjectId);
      if (leaseToken === undefined || this.providerCommandId(subjectId) !== providerCommandId) {
        throw new Error("Greeting cohort receipt command identity was lost");
      }
      return { leaseToken, subjectId };
    });
    await port.confirmGreetingCohortStarted({
      kind: "greeting",
      meetingId: this.dependencies.meetingId,
      providerCommandId,
      receipts,
      startedAtMilliseconds,
    });
  }

  public async release(participantId: string, evidence: "busy" | "unplayed"): Promise<void> {
    const leaseToken = this.activeLeaseTokens.get(participantId);
    if (leaseToken === undefined) {
      return;
    }
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
    this.activeLeaseTokens.delete(participantId);
    this.activeProviderCommandIds.delete(participantId);
    this.reservedParticipantIds.delete(participantId);
  }

  public async settle(
    participantId: string,
    outcome: "played" | "suppressed",
    reason?: "ambiguous" | "capacity" | "stale",
  ): Promise<void> {
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
    }) ?? Promise.resolve();
    await settlement;
    this.completedParticipantIds.add(participantId);
    this.recoveryRequiredParticipantIds.delete(participantId);
    this.activeLeaseTokens.delete(participantId);
    this.activeProviderCommandIds.delete(participantId);
    this.reservedParticipantIds.delete(participantId);
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

  public async reconcileCapacity(
    orderedParticipantIds: readonly string[],
    capacity: number,
  ): Promise<LiveConversationGreetingCapacityReconciliation> {
    const port = this.dependencies.port;
    if (port === undefined) {
      return {
        commandedSubjectIds: [],
        suppressedSubjectIds: orderedParticipantIds.slice(capacity),
        terminalSubjectIds: [],
      };
    }
    if (port.reconcileGreetingCapacity === undefined) {
      throw new Error("Greeting capacity recovery requires atomic durable reconciliation");
    }
    return port.reconcileGreetingCapacity({
      capacity,
      kind: "greeting",
      meetingId: this.dependencies.meetingId,
      orderedSubjectIds: orderedParticipantIds,
    });
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
    reclaimActive: boolean,
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
        providerCommandId: `participant-greeting:${participantId}`,
        status: "reserved",
      });
    }
    return this.dependencies.port.reserve({
      kind: "greeting",
      leaseSeconds: oneShotReceiptLeaseSeconds,
      meetingId: this.dependencies.meetingId,
      ...(reclaimActive ? { reclaimActive: true } : {}),
      subjectId: participantId,
    });
  }
}
