import type { LiveConversationConfiguration, LiveRuntimeLogger,
  LiveRuntimeTimer } from "./contracts.js";
import { ParticipantGreetingQueue, type ParticipantGreetingPriority,
} from "./participant-greeting-queue.js";
import { participantGreetingProfile, resolveParticipantGreeting,
  type ResolvedParticipantGreeting } from "./participant-greeting-content.js";
import { playParticipantGreeting,
  type ParticipantGreetingPlayback,
} from "./participant-greeting-playback.js";
import {
  participantGreetingDeadlineReason as greetingDeadlineReason,
  ParticipantGreetingDeadlines,
} from "./participant-greeting-deadline.js";
import { ParticipantGreetingReceipts } from "./participant-greeting-receipts.js";
import {
  ParticipantGreetingScheduling,
  reserveGreetingPlaybackAdmission,
} from "./participant-greeting-scheduling.js";
import {
  coordinateGreetingPlayback,
} from "./participant-greeting-settlement.js";
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
  private readonly deadlines: ParticipantGreetingDeadlines;
  private drainPromise: Promise<void> | null = null;
  private readonly greetedParticipantIds = new Set<string>();
  private readonly pendingGreetings = new ParticipantGreetingQueue();
  private readonly presentParticipantIds = new Set<string>();
  private readonly receipts: ParticipantGreetingReceipts;
  private readonly scheduling: ParticipantGreetingScheduling;
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
    this.scheduling = new ParticipantGreetingScheduling({
      configuration: dependencies.configuration,
      meetingId: dependencies.meetingId,
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
    if (!this.scheduling.isActive) {
      this.suppressCohortOverflow();
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
    if (!this.scheduling.isActive) {
      this.suppressCohortOverflow();
    }
    this.tryAdvance();
  }
  public participantLeft(participantId: string): void {
    this.presentParticipantIds.delete(participantId);
    this.pendingGreetings.delete(participantId);
    this.scheduling.forget(participantId);
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
    this.scheduling.clear();
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
    if (idle.status !== "completed" || this.shouldStopGreeting(participantId)) {
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
    if (!this.scheduling.canStartBeforeDeadline(
      this.deadlines.expiresAtMilliseconds(participantId),
      this.nowMilliseconds(),
    )) {
      this.suppressCapacityOverflow(participantId);
      return false;
    }
    const leaseToken = await reserveGreetingPlaybackAdmission({
      clearTerminal: () => {
        this.clearTerminalState(participantId);
      },
      deadlines: this.deadlines,
      markGreeted: () => this.greetedParticipantIds.add(participantId),
      nowMilliseconds: () => this.nowMilliseconds(),
      participantId,
      receipts: this.receipts,
    });
    if (leaseToken === undefined) {
      return false;
    }
    if (!this.deadlines.ensureFresh(participantId, this.nowMilliseconds())) {
      await this.receipts.settle(participantId, "suppressed", "stale");
      return false;
    }
    const beginAttempt = this.receipts.beginAttempt(participantId, leaseToken);
    const attemptResult = await this.deadlines.race(
      participantId,
      beginAttempt,
      () => this.nowMilliseconds(),
    );
    if (attemptResult.status === "expired") {
      this.greetedParticipantIds.add(participantId);
      void attemptResult.operation.then(
        () => this.receipts.settle(participantId, "suppressed", "ambiguous"),
        () => this.receipts.fenceOnce(participantId),
      ).catch(() => {});
      return false;
    }
    if (!this.deadlines.ensureFresh(participantId, this.nowMilliseconds())) {
      await this.receipts.settle(participantId, "suppressed", "ambiguous");
      return false;
    }
    const playback = this.speak(participantId, greeting);
    const playbackBound = this.scheduling.beginSlot(
      participantId,
      this.nowMilliseconds(),
    );
    const coordinated = await coordinateGreetingPlayback({
      clearTerminal: () => {
        this.clearTerminalState(participantId);
      },
      deadlines: this.deadlines,
      dependencies: this.settlementDependencies(),
      markGreeted: () => this.greetedParticipantIds.add(participantId),
      observeFirstAudio: (startedAtMilliseconds) => {
        this.scheduling.observeFirstAudio(startedAtMilliseconds, playbackBound);
      },
      participantId,
      playback,
      playbackBoundMilliseconds: playbackBound,
      receipts: this.receipts,
      releaseSlot: () => {
        this.scheduling.releaseSlot();
      },
      suppressOverflow: () => {
        this.suppressCohortOverflow();
      },
    });
    return coordinated.status === "terminal"
      ? false
      : this.scheduling.settleOutcome({
          clearTerminal: () => {
            this.clearTerminalState(participantId);
          },
          deadlines: this.deadlines,
          isPresent: () => this.presentParticipantIds.has(participantId),
          logger: this.dependencies.logger,
          markGreeted: () => this.greetedParticipantIds.add(participantId),
          meetingId: this.dependencies.meetingId,
          nowMilliseconds: () => this.nowMilliseconds(),
          outcome: coordinated.outcome,
          participantId,
          pendingGreetings: this.pendingGreetings,
          priority,
          receipts: this.receipts,
        });
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
      const greeting = this.greeting(participantId);
      if (greeting !== undefined) {
        this.scheduling.plan(participantId, greeting);
      }
      return;
    }
    this.pendingGreetings.enqueue(participantId, priority);
  }
  private expire(participantId: string): void {
    this.pendingGreetings.delete(participantId);
    this.scheduling.forget(participantId);
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
    this.scheduling.forget(participantId);
  }
  private suppressCohortOverflow(): void {
    const overflow = this.scheduling.cohortOverflow(
      this.pendingGreetings.orderedReady(),
      (participantId) => this.deadlines.expiresAtMilliseconds(participantId),
      this.nowMilliseconds(),
    );
    for (const participantId of overflow) {
      this.suppressCapacityOverflow(participantId);
    }
  }
  private suppressCapacityOverflow(participantId: string): void {
    this.pendingGreetings.delete(participantId);
    this.deadlines.clear(participantId);
    this.scheduling.forget(participantId);
    this.greetedParticipantIds.add(participantId);
    this.dependencies.logger.warn("Participant greeting suppressed before admission", {
      meetingId: this.dependencies.meetingId,
      participantId,
      reason: "join-cohort-capacity",
    });
    this.deadlines.track(this.receipts.fenceOnce(participantId));
  }
  private speak(
    participantId: string,
    greeting: ResolvedParticipantGreeting,
  ): ParticipantGreetingPlayback {
    const retryCount = this.scheduling.retryCount(participantId);
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
      preparedCue: this.scheduling.preparedCue(participantId),
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
  private settlementDependencies() {
    return {
      configuration: this.dependencies.configuration,
      logger: this.dependencies.logger,
      meetingId: this.dependencies.meetingId,
      nowMilliseconds: () => this.nowMilliseconds(),
      timer: this.dependencies.timer,
    };
  }
}
