import type {
  LiveConversationConfiguration,
  LiveConversationOneShotReceiptReservation,
  LiveRuntimeLogger,
  LiveRuntimeTimer,
} from "./contracts.js";
import {
  ParticipantGreetingQueue,
  type ParticipantGreetingPriority,
} from "./participant-greeting-queue.js";
import {
  participantGreetingProfile,
  resolveParticipantGreeting,
  type GreetingAttemptOutcome,
  type ResolvedParticipantGreeting,
} from "./participant-greeting-content.js";
import { playParticipantGreeting } from "./participant-greeting-playback.js";
import {
  participantGreetingDeadlineReason as greetingDeadlineReason,
  ParticipantGreetingDeadlines,
} from "./participant-greeting-deadline.js";
const maximumSafeRetries = 3;
const oneShotReceiptLeaseSeconds = 120;

interface PendingGreetingCompletion {
  readonly leaseToken: string;
}

interface ParticipantGreetingBridgeDependencies {
  readonly configuration: LiveConversationConfiguration;
  readonly isMeetingFinishing: () => boolean;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly timer: LiveRuntimeTimer;
}

/** Meeting-local, bounded queue for one proactive greeting per participant. */
export class ParticipantGreetingBridge {
  private readonly activeLeaseTokens = new Map<string, string>();
  private closed = false;
  private readonly deadlines: ParticipantGreetingDeadlines;
  private drainPromise: Promise<void> | null = null;
  private readonly greetedParticipantIds = new Set<string>();
  private readonly pendingGreetings = new ParticipantGreetingQueue();
  private readonly pendingCompletions = new Map<string, PendingGreetingCompletion>();
  private readonly presentParticipantIds = new Set<string>();
  private readonly queuedAtMillisecondsByParticipantId = new Map<string, number>();
  private readonly reservationInProgressParticipantIds = new Set<string>();
  private readonly reservedParticipantIds = new Set<string>();
  private readonly retryCounts = new Map<string, number>();

  public constructor(private readonly dependencies: ParticipantGreetingBridgeDependencies) {
    this.deadlines = new ParticipantGreetingDeadlines(dependencies.timer, (participantId) => {
      this.expire(participantId);
    });
  }

  public participantsPresent(participantIds: readonly string[]): void {
    for (const participantId of participantIds) {
      if (this.closed) {
        return;
      }
      this.presentParticipantIds.add(participantId);
      const greeting = this.greeting(participantId);
      if (greeting !== undefined && !this.greetedParticipantIds.has(participantId)) {
        this.enqueue(
          participantId,
          this.profile(participantId) === undefined ? "high" : "initial",
        );
      }
    }
    this.tryAdvance();
  }

  /** Restores presence; the durable receipt decides whether playback is due. */
  public participantsRestored(participantIds: readonly string[]): void {
    this.participantsPresent(participantIds);
  }

  public participantJoined(participantId: string): void {
    if (this.closed) {
      return;
    }
    this.presentParticipantIds.add(participantId);
    if (
      this.greeting(participantId) !== undefined &&
      !this.greetedParticipantIds.has(participantId)
    ) {
      this.enqueue(participantId, "high");
    }
    this.tryAdvance();
  }

  public participantLeft(participantId: string): void {
    this.presentParticipantIds.delete(participantId);
    this.pendingGreetings.delete(participantId);
    this.deadlines.clear(participantId);
    this.queuedAtMillisecondsByParticipantId.delete(participantId);
  }

  public advance(): void {
    this.pendingGreetings.releaseDeferredRetries();
    this.tryAdvance();
  }

  private tryAdvance(): void {
    if (
      this.dependencies.configuration.greetings === undefined ||
      this.closed ||
      this.dependencies.isMeetingFinishing() ||
      this.drainPromise !== null ||
      (!this.pendingGreetings.hasReady() && this.pendingCompletions.size === 0)
    ) {
      return;
    }

    let draining!: Promise<void>;
    draining = this.drain()
      .catch((error: unknown) => {
        this.dependencies.logger.warn("Participant greeting queue failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
          meetingId: this.dependencies.meetingId,
        });
      })
      .finally(() => {
        if (this.drainPromise === draining) {
          this.drainPromise = null;
        }
      });
    this.drainPromise = draining;
  }

  public close(): void {
    this.closed = true;
    this.pendingGreetings.clear();
    this.presentParticipantIds.clear();
    this.deadlines.clearAll();
    this.queuedAtMillisecondsByParticipantId.clear();
  }

  public async settle(): Promise<void> {
    await this.drainPromise;
    await this.deadlines.settle();
  }

  private async drain(): Promise<void> {
    const greetings = this.dependencies.configuration.greetings;
    if (greetings === undefined) {
      return;
    }

    await this.completePendingSettlements();
    while (!this.closed && !this.dependencies.isMeetingFinishing()) {
      if (!greetings.isPlaybackReady(this.dependencies.meetingId)) {
        return;
      }
      const pending = this.pendingGreetings.takeNext();
      if (pending === undefined) {
        return;
      }
      const { participantId } = pending;
      const greeting = this.greeting(participantId);
      if (
        greeting === undefined ||
        !this.presentParticipantIds.has(participantId) ||
        this.greetedParticipantIds.has(participantId)
      ) {
        continue;
      }

      const idle = await this.deadlines.race(
        participantId,
        this.dependencies.configuration.coordinator.whenIdle(
          this.dependencies.meetingId,
        ),
      );
      if (idle.status !== "completed") {
        continue;
      }
      if (this.shouldStopGreeting(participantId)) {
        continue;
      }
      if (!greetings.isPlaybackReady(this.dependencies.meetingId)) {
        this.enqueue(participantId, pending.priority);
        return;
      }

      const reservationOperation = this.reserve(participantId);
      this.reservationInProgressParticipantIds.add(participantId);
      void reservationOperation.finally(() => {
        this.reservationInProgressParticipantIds.delete(participantId);
      }).catch(() => {});
      const receiptResult = await this.deadlines.race(participantId, reservationOperation);
      if (receiptResult.status === "expired") {
        this.greetedParticipantIds.add(participantId);
        void receiptResult.operation.then(async (lateReceipt) => {
          if (lateReceipt.status === "reserved") {
            this.activeLeaseTokens.set(participantId, lateReceipt.leaseToken);
            await this.complete(participantId, lateReceipt.leaseToken);
          }
          this.queuedAtMillisecondsByParticipantId.delete(participantId);
          return;
        }).catch(() => {});
        continue;
      }
      const receipt = receiptResult.value;
      if (receipt.status !== "reserved") {
        this.greetedParticipantIds.add(participantId);
        this.deadlines.clear(participantId);
        this.retryCounts.delete(participantId);
        this.queuedAtMillisecondsByParticipantId.delete(participantId);
        continue;
      }
      this.activeLeaseTokens.set(participantId, receipt.leaseToken);
      const speaking = await this.deadlines.race(
        participantId,
        this.speak(participantId, greeting),
      );
      if (speaking.status === "expired") {
        this.greetedParticipantIds.add(participantId);
        this.pendingCompletions.set(participantId, { leaseToken: receipt.leaseToken });
        await this.cancelExpiredAdmission(participantId);
        await this.completePendingSettlements();
        continue;
      }
      const outcome = speaking.value;
      if (await this.settleOutcome(participantId, pending.priority, receipt.leaseToken, outcome)) {
        return;
      }
    }
  }

  private async settleOutcome(
    participantId: string,
    priority: ParticipantGreetingPriority,
    leaseToken: string,
    outcome: GreetingAttemptOutcome,
  ): Promise<boolean> {
    if (outcome === "busy" || outcome === "unplayed") {
      const retryCount = (this.retryCounts.get(participantId) ?? 0) + 1;
      this.retryCounts.set(participantId, retryCount);
      if (retryCount <= maximumSafeRetries && this.presentParticipantIds.has(participantId)) {
        await this.release(participantId, leaseToken);
        this.pendingGreetings.deferRetry(participantId, priority);
        return true;
      }
      this.dependencies.logger.warn("Participant greeting retries exhausted", {
        meetingId: this.dependencies.meetingId,
        participantId,
      });
    } else if (outcome !== "played" && outcome !== "partial" && outcome !== "unknown" &&
      outcome !== "failed" && outcome !== "queued" && outcome !== "reused") {
      await this.release(participantId, leaseToken);
      this.greetedParticipantIds.add(participantId);
      this.deadlines.clear(participantId);
      return false;
    }
    this.greetedParticipantIds.add(participantId);
    this.pendingCompletions.set(participantId, { leaseToken });
    await this.completePendingSettlements();
    return false;
  }

  private reserve(participantId: string): Promise<LiveConversationOneShotReceiptReservation> {
    const receipts = this.dependencies.configuration.oneShotReceipts;
    if (receipts === undefined) {
      if (this.greetedParticipantIds.has(participantId)) {
        return Promise.resolve({ status: "completed" });
      }
      if (this.reservedParticipantIds.has(participantId)) {
        return Promise.resolve({ status: "in_flight" });
      }
      this.reservedParticipantIds.add(participantId);
      return Promise.resolve({ leaseToken: `meeting-local-greeting:${participantId}`,
        status: "reserved" });
    }
    return receipts.reserve({
      kind: "greeting", leaseSeconds: oneShotReceiptLeaseSeconds,
      meetingId: this.dependencies.meetingId, subjectId: participantId,
    });
  }

  private complete(participantId: string, leaseToken: string): Promise<void> {
    const completed = this.dependencies.configuration.oneShotReceipts?.complete({
      kind: "greeting", leaseToken,
      meetingId: this.dependencies.meetingId,
      subjectId: participantId,
    }) ?? Promise.resolve();
    return completed.finally(() => {
      this.activeLeaseTokens.delete(participantId);
      this.reservedParticipantIds.delete(participantId);
    });
  }

  private release(participantId: string, leaseToken: string): Promise<void> {
    const released = this.dependencies.configuration.oneShotReceipts?.release({
      kind: "greeting", leaseToken,
      meetingId: this.dependencies.meetingId,
      subjectId: participantId,
    }) ?? Promise.resolve();
    return released.finally(() => {
      this.activeLeaseTokens.delete(participantId);
      this.reservedParticipantIds.delete(participantId);
    });
  }

  private enqueue(
    participantId: string,
    priority: ParticipantGreetingPriority,
  ): void {
    if (!this.queuedAtMillisecondsByParticipantId.has(participantId)) {
      this.queuedAtMillisecondsByParticipantId.set(
        participantId,
        this.nowMilliseconds(),
      );
      this.deadlines.start(participantId);
    }
    this.pendingGreetings.enqueue(participantId, priority);
  }

  private expire(participantId: string): void {
    this.pendingGreetings.delete(participantId);
    this.retryCounts.delete(participantId);
    this.dependencies.logger.warn("Participant greeting reached terminal deadline", {
      meetingId: this.dependencies.meetingId,
      participantId,
      reason: greetingDeadlineReason,
    });
    if (!this.activeLeaseTokens.has(participantId) &&
      !this.reservationInProgressParticipantIds.has(participantId)) {
      this.deadlines.track(this.fenceExpiredBeforeAdmission(participantId));
    }
  }

  private async completePendingSettlements(): Promise<void> {
    for (const [participantId, pending] of this.pendingCompletions) {
      await this.complete(participantId, pending.leaseToken);
      this.pendingCompletions.delete(participantId);
      this.deadlines.clear(participantId);
      this.retryCounts.delete(participantId);
      this.queuedAtMillisecondsByParticipantId.delete(participantId);
    }
  }

  private async fenceExpiredBeforeAdmission(participantId: string): Promise<void> {
    this.greetedParticipantIds.add(participantId);
    try {
      const receipt = await this.reserve(participantId);
      if (receipt.status === "reserved") {
        this.activeLeaseTokens.set(participantId, receipt.leaseToken);
        await this.complete(participantId, receipt.leaseToken);
      }
      this.queuedAtMillisecondsByParticipantId.delete(participantId);
    } catch (error) {
      this.dependencies.logger.warn("Participant greeting deadline settlement failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        meetingId: this.dependencies.meetingId,
        participantId,
        reason: greetingDeadlineReason,
      });
    }
  }

  private async cancelExpiredAdmission(participantId: string): Promise<void> {
    try {
      await this.dependencies.configuration.coordinator.participantLeft?.(
        this.dependencies.meetingId,
        participantId,
        this.nowMilliseconds(),
      );
    } catch (error) {
      this.dependencies.logger.warn("Participant greeting deadline cancellation failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        meetingId: this.dependencies.meetingId,
        participantId,
        reason: greetingDeadlineReason,
      });
    }
  }

  private async speak(
    participantId: string,
    greeting: ResolvedParticipantGreeting,
  ): Promise<GreetingAttemptOutcome> {
    const retryCount = this.retryCounts.get(participantId) ?? 0;
    const turnId = retryCount === 0
      ? `participant-greeting:${participantId}`
      : `participant-greeting:${participantId}:retry-${retryCount}`;
    return playParticipantGreeting({
      configuration: this.dependencies.configuration,
      greeting,
      isNamed: this.profile(participantId) !== undefined,
      logger: this.dependencies.logger,
      meetingId: this.dependencies.meetingId,
      nowMilliseconds: () => this.nowMilliseconds(),
      observedLatencyMilliseconds: () =>
        this.observedGreetingLatencyMilliseconds(participantId),
      participantId,
      shouldStop: () => this.shouldStopGreeting(participantId),
      turnId,
    });
  }

  private profile(participantId: string) { return participantGreetingProfile(this.dependencies.configuration, participantId); }

  private greeting(participantId: string): ResolvedParticipantGreeting | undefined {
    return resolveParticipantGreeting(
      this.dependencies.configuration,
      participantId,
    );
  }

  /** Re-reads mutable meeting state after asynchronous coordinator settlement. */
  private shouldStopGreeting(participantId: string): boolean {
    return this.closed ||
      this.dependencies.isMeetingFinishing() ||
      !this.presentParticipantIds.has(participantId);
  }

  private nowMilliseconds(): number {
    const value = Math.floor(this.dependencies.configuration.nowMilliseconds());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Greeting observation clock must be a non-negative integer");
    }
    return value;
  }

  private observedGreetingLatencyMilliseconds(participantId: string): number {
    const queuedAtMs = this.queuedAtMillisecondsByParticipantId.get(participantId);
    return queuedAtMs === undefined
      ? 0
      : Math.max(0, this.nowMilliseconds() - queuedAtMs);
  }
}
