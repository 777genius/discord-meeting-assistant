import type { LiveConversationConfiguration, LiveRuntimeLogger,
  LiveRuntimeTimer } from "./contracts.js";
import { ParticipantGreetingQueue, type ParticipantGreetingPriority,
} from "./participant-greeting-queue.js";
import {
  participantGreetingProfile, resolveParticipantGreeting,
  type GreetingAttemptOutcome, type ResolvedParticipantGreeting,
} from "./participant-greeting-content.js";
import { cancelParticipantGreetingPlayback, playParticipantGreeting,
  type ParticipantGreetingPlayback,
} from "./participant-greeting-playback.js";
import {
  participantGreetingDeadlineReason as greetingDeadlineReason,
  ParticipantGreetingDeadlines,
} from "./participant-greeting-deadline.js";
import { ParticipantGreetingReceipts } from "./participant-greeting-receipts.js";
const maximumSafeRetries = 3;
interface ParticipantGreetingBridgeDependencies {
  readonly configuration: LiveConversationConfiguration;
  readonly isMeetingFinishing: () => boolean;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly timer: LiveRuntimeTimer;
}
/** Meeting-local, bounded queue for one proactive greeting per participant. */
export class ParticipantGreetingBridge {
  private advanceRequested = false;
  private closed = false;
  private readonly committedParticipantIds = new Set<string>();
  private readonly deadlines: ParticipantGreetingDeadlines;
  private drainPromise: Promise<void> | null = null;
  private readonly greetedParticipantIds = new Set<string>();
  private readonly pendingGreetings = new ParticipantGreetingQueue();
  private readonly presentParticipantIds = new Set<string>();
  private readonly receipts: ParticipantGreetingReceipts;
  private readonly retryCounts = new Map<string, number>();
  public constructor(private readonly dependencies: ParticipantGreetingBridgeDependencies) {
    this.deadlines = new ParticipantGreetingDeadlines(dependencies.timer, (participantId) => {
      this.expire(participantId);
    });
    this.receipts = new ParticipantGreetingReceipts({
      logger: dependencies.logger,
      meetingId: dependencies.meetingId,
      ...(dependencies.configuration.oneShotReceipts === undefined
        ? {}
        : { port: dependencies.configuration.oneShotReceipts }),
    });
  }
  public participantsPresent(participantIds: readonly string[], occurredAt: string): void {
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
          occurredAt,
        );
      }
    }
    this.tryAdvance();
  }
  /** Restores presence; the durable receipt decides whether playback is due. */
  public participantsRestored(participantIds: readonly string[], occurredAt: string): void {
    this.participantsPresent(participantIds, occurredAt);
  }
  public participantJoined(participantId: string, occurredAt: string): void {
    if (this.closed) {
      return;
    }
    this.presentParticipantIds.add(participantId);
    if (
      this.greeting(participantId) !== undefined &&
      !this.greetedParticipantIds.has(participantId)
    ) {
      this.enqueue(participantId, "high", occurredAt);
    }
    this.tryAdvance();
  }
  public participantLeft(participantId: string): void {
    this.presentParticipantIds.delete(participantId);
    this.pendingGreetings.delete(participantId);
    this.deadlines.cancel(participantId);
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
      !this.pendingGreetings.hasReady()
    ) {
      return;
    }
    if (this.drainPromise !== null) {
      this.advanceRequested = true;
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
          const shouldAdvance = this.advanceRequested;
          this.advanceRequested = false;
          if (shouldAdvance) {
            this.tryAdvance();
          }
        }
      });
    this.drainPromise = draining;
  }
  public close(): void {
    this.closed = true;
    this.advanceRequested = false;
    this.pendingGreetings.clear();
    this.presentParticipantIds.clear();
    this.deadlines.cancelAll();
  }
  public async settle(): Promise<void> {
    while (this.drainPromise !== null) {
      await this.drainPromise;
    }
    await this.deadlines.settle();
  }
  private async drain(): Promise<void> {
    const greetings = this.dependencies.configuration.greetings;
    if (greetings === undefined) {
      return;
    }
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

      if (await this.processGreeting(participantId, pending.priority, greeting)) {
        return;
      }
    }
  }

  private async processGreeting(
    participantId: string,
    priority: ParticipantGreetingPriority,
    greeting: ResolvedParticipantGreeting,
  ): Promise<boolean> {
    const idle = await this.deadlines.race(
        participantId,
        this.dependencies.configuration.coordinator.whenIdle(
          this.dependencies.meetingId,
        ),
        () => this.nowMilliseconds(),
      );
      if (idle.status !== "completed") {
        return false;
      }
      if (this.shouldStopGreeting(participantId)) {
        return false;
      }
      const greetings = this.dependencies.configuration.greetings;
      if (greetings === undefined) {
        return false;
      }
      if (!greetings.isPlaybackReady(this.dependencies.meetingId)) {
        this.enqueue(participantId, priority);
        return true;
      }

      if (
        !this.committedParticipantIds.has(participantId) &&
        !await this.commitPlaybackAdmission(participantId)
      ) {
        return false;
      }
      // The durable write is a necessary fence, not a freshness grant. Re-read
      // the absolute producer-time deadline immediately before the irreversible
      // provider call in case the commit consumed the remaining budget.
      if (!this.deadlines.ensureFresh(participantId, this.nowMilliseconds())) {
        return false;
      }
      const playback = this.speak(participantId, greeting);
      const firstAudio = await this.deadlines.race(
        participantId,
        playback.firstAudio,
        () => this.nowMilliseconds(),
      );
      if (firstAudio.status === "expired") {
        this.greetedParticipantIds.add(participantId);
        await this.cancelPlayback(participantId);
        // The durable fence already suppresses replay. A provider settlement may
        // never arrive after cancellation or process loss, so it cannot gate the
        // meeting-local queue or recovery.
        this.detachPlaybackSettlement(playback);
        return false;
      }
      if (firstAudio.value.status === "unplayed") {
        const outcome = await playback.settlement;
        if (outcome === "busy" || outcome === "unplayed") {
          if (this.settleOutcome(participantId, priority, outcome)) {
            return true;
          }
          return false;
        }
        this.greetedParticipantIds.add(participantId);
        await this.cancelPlayback(participantId);
        this.clearTerminalState(participantId);
        return false;
      }
      if (!this.deadlines.acceptFirstAudio(
        participantId,
        firstAudio.value.startedAtMilliseconds,
      )) {
        this.greetedParticipantIds.add(participantId);
        await this.cancelPlayback(participantId);
        this.detachPlaybackSettlement(playback);
        this.clearTerminalState(participantId);
        return false;
      }
      const outcome = await playback.settlement;
    return this.settleOutcome(participantId, priority, outcome);
  }

  private settleOutcome(
    participantId: string,
    priority: ParticipantGreetingPriority,
    outcome: GreetingAttemptOutcome,
  ): boolean {
    if (outcome === "busy" || outcome === "unplayed") {
      const retryCount = (this.retryCounts.get(participantId) ?? 0) + 1;
      this.retryCounts.set(participantId, retryCount);
      if (retryCount <= maximumSafeRetries && this.presentParticipantIds.has(participantId)) {
        if (!this.deadlines.ensureFresh(participantId, this.nowMilliseconds())) {
          return false;
        }
        this.pendingGreetings.deferRetry(participantId, priority);
        return true;
      }
      this.dependencies.logger.warn("Participant greeting retries exhausted", {
        meetingId: this.dependencies.meetingId,
        participantId,
      });
    } else if (outcome !== "played" && outcome !== "partial" && outcome !== "unknown" &&
      outcome !== "failed" && outcome !== "queued" && outcome !== "reused") {
      this.greetedParticipantIds.add(participantId);
      this.clearTerminalState(participantId);
      return false;
    }
    this.greetedParticipantIds.add(participantId);
    this.clearTerminalState(participantId);
    return false;
  }

  /** Commits the one-shot identity before any provider can observe playback. */
  private async commitPlaybackAdmission(participantId: string): Promise<boolean> {
    if (!this.deadlines.ensureFresh(participantId, this.nowMilliseconds())) {
      await this.receipts.fenceOnce(participantId);
      return false;
    }
    const reservationOperation = this.receipts.reserve(participantId);
    const receiptResult = await this.deadlines.race(
      participantId,
      reservationOperation,
      () => this.nowMilliseconds(),
    );
    if (receiptResult.status === "expired") {
      this.greetedParticipantIds.add(participantId);
      this.deadlines.track(this.receipts.settleExpiredReservation(
        participantId,
        receiptResult.operation,
      ));
      return false;
    }
    const receipt = receiptResult.value;
    if (receipt.status !== "reserved") {
      this.greetedParticipantIds.add(participantId);
      this.clearTerminalState(participantId);
      return false;
    }
    const commitResult = await this.deadlines.race(
      participantId,
      this.receipts.commit(participantId, receipt.leaseToken),
      () => this.nowMilliseconds(),
    );
    if (commitResult.status === "expired") {
      this.greetedParticipantIds.add(participantId);
      return false;
    }
    this.committedParticipantIds.add(participantId);
    return true;
  }

  private enqueue(
    participantId: string,
    priority: ParticipantGreetingPriority,
    occurredAt?: string,
  ): void {
    if (!this.deadlines.has(participantId)) {
      if (occurredAt === undefined) {
        return;
      }
      this.pendingGreetings.enqueue(participantId, priority);
      this.deadlines.start(
        participantId,
        occurredAt,
        this.nowMilliseconds(),
      );
      return;
    }
    this.pendingGreetings.enqueue(participantId, priority);
  }

  private expire(participantId: string): void {
    this.pendingGreetings.delete(participantId);
    this.retryCounts.delete(participantId);
    this.greetedParticipantIds.add(participantId);
    this.dependencies.logger.warn("Participant greeting reached terminal deadline", {
      meetingId: this.dependencies.meetingId,
      participantId,
      reason: greetingDeadlineReason,
    });
    if (!this.receipts.isFencedOrActive(participantId)) {
      this.deadlines.track(this.receipts.fenceOnce(participantId));
    }
  }

  private clearTerminalState(participantId: string): void {
    this.deadlines.clear(participantId);
    this.retryCounts.delete(participantId);
  }

  private cancelPlayback(participantId: string): Promise<void> {
    return cancelParticipantGreetingPlayback(
      this.dependencies.configuration, this.dependencies.logger,
      this.dependencies.meetingId, participantId, this.nowMilliseconds(),
    );
  }

  private detachPlaybackSettlement(playback: ParticipantGreetingPlayback): void {
    // Cancellation and process recovery must not wait for a provider that can
    // settle late (or never settle), but a late rejection must still be handled.
    void playback.settlement.catch(() => {});
  }

  private speak(
    participantId: string,
    greeting: ResolvedParticipantGreeting,
  ): ParticipantGreetingPlayback {
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
    return this.deadlines.observedLatencyMilliseconds(participantId, this.nowMilliseconds());
  }
}
