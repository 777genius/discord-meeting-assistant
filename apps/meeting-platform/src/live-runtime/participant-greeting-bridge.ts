import type { LiveConversationConfiguration, LiveRuntimeLogger,
  LiveRuntimeTimer } from "./contracts.js";
import { ParticipantGreetingQueue, type ParticipantGreetingPriority,
} from "./participant-greeting-queue.js";
import { participantGreetingProfile, resolveParticipantGreeting,
  resolveParticipantGreetingCohort,
  type GreetingAttemptOutcome,
  type ResolvedParticipantGreeting } from "./participant-greeting-content.js";
import { playParticipantGreeting,
  cancelParticipantGreetingPlayback,
  selectParticipantGreetingAnonymousCue,
  type ParticipantGreetingPlayback,
} from "./participant-greeting-playback.js";
import {
  participantGreetingDeadlineReason as greetingDeadlineReason,
  ParticipantGreetingDeadlines,
} from "./participant-greeting-deadline.js";
import { ParticipantGreetingReceipts } from "./participant-greeting-receipts.js";
import {
  type GreetingPlaybackAdmission,
  ParticipantGreetingScheduling,
  reserveGreetingPlaybackAdmission,
} from "./participant-greeting-scheduling.js";
import {
  coordinateGreetingPlayback,
} from "./participant-greeting-settlement.js";

async function completedVoid(operation: Promise<void>) {
  await operation;
  return { status: "completed", value: undefined } as const;
}

interface ParticipantGreetingBridgeDependencies {
  readonly configuration: LiveConversationConfiguration;
  readonly isMeetingFinishing: () => boolean;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly recoverInFlight?: boolean;
  readonly timer: LiveRuntimeTimer;
}
/** Keeps small-call admission bounded without coupling the runtime to today's seven names. */
const maximumSupportedCohortSize = 12;
/** Meeting-local, bounded queue for one proactive greeting per participant. */
export class ParticipantGreetingBridge {
  private activeGreetingParticipantId: string | null = null;
  private advanceRequested = false;
  private readonly capacityExemptParticipantIds = new Set<string>();
  private capacityReconciliationGeneration = 0;
  private capacityReconciledGeneration = 0;
  private capacityReconciliationRequired = false;
  private capacityReconciliationTask: Promise<void> | null = null;
  private closed = false;
  private readonly deadlines: ParticipantGreetingDeadlines;
  private drainPromise: Promise<void> | null = null;
  private readonly greetedParticipantIds = new Set<string>();
  private readonly pendingGreetings = new ParticipantGreetingQueue();
  private readonly presentParticipantIds = new Set<string>();
  private readonly preReservedAdmissions = new Map<string, GreetingPlaybackAdmission>();
  private readonly recoveryParticipantIds = new Set<string>();
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
    let hasGreetingCandidate = false;
    for (const participantId of participantIds) {
      if (this.closed) {
        return;
      }
      this.presentParticipantIds.add(participantId);
      const greeting = this.greeting(participantId);
      if (greeting !== undefined && !this.greetedParticipantIds.has(participantId)) {
        hasGreetingCandidate = true;
        this.enqueue(
          participantId,
          this.profile(participantId) === undefined ? "high" : "initial",
          occurredAt,
        );
      }
    }
    if (hasGreetingCandidate) {
      this.capacityReconciliationGeneration += 1;
      this.requestCapacityReconciliation();
    }
    this.tryAdvance();
  }
  /** Restores presence; the durable receipt decides whether playback is due. */
  public participantsRestored(participantIds: readonly string[], occurredAt: string): void {
    for (const participantId of participantIds) {
      this.recoveryParticipantIds.add(participantId);
    }
    this.participantsPresent(participantIds, occurredAt);
  }
  public participantJoined(participantId: string, occurredAt: string): void {
    if (this.closed) {
      return;
    }
    this.presentParticipantIds.add(participantId);
    if (this.dependencies.recoverInFlight === true) {
      this.recoveryParticipantIds.add(participantId);
    }
    if (
      this.greeting(participantId) !== undefined &&
      !this.greetedParticipantIds.has(participantId)
    ) {
      this.enqueue(participantId, "high", occurredAt);
      // Every actor-qualified incremental join must cross the durable capacity
      // transaction before its queue entry can reach playback.
      this.capacityReconciliationGeneration += 1;
      this.requestCapacityReconciliation();
      this.preemptActiveGreeting();
    }
    this.tryAdvance();
  }
  public participantLeft(participantId: string): void {
    this.presentParticipantIds.delete(participantId);
    this.pendingGreetings.delete(participantId);
    this.capacityExemptParticipantIds.delete(participantId);
    this.preReservedAdmissions.delete(participantId);
    this.scheduling.forget(participantId);
    this.deadlines.cancel(participantId);
  }
  public advance(): void {
    this.pendingGreetings.releaseDeferredRetries();
    if (this.capacityReconciliationRequired) {
      this.requestCapacityReconciliation();
    }
    this.tryAdvance();
  }
  private tryAdvance(): void {
    if (
      this.dependencies.configuration.greetings === undefined ||
      this.closed ||
      this.dependencies.isMeetingFinishing() ||
      this.capacityReconciliationRequired ||
      this.capacityReconciliationTask !== null ||
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
    this.preemptActiveGreeting();
    this.advanceRequested = false;
    this.pendingGreetings.clear();
    this.capacityExemptParticipantIds.clear();
    this.capacityReconciledGeneration = this.capacityReconciliationGeneration;
    this.capacityReconciliationRequired = false;
    this.preReservedAdmissions.clear();
    this.scheduling.clear();
    this.presentParticipantIds.clear();
    this.recoveryParticipantIds.clear();
    this.deadlines.cancelAll();
  }
  public async settle(): Promise<void> {
    while (this.drainPromise !== null || this.capacityReconciliationTask !== null) {
      await Promise.all([
        this.drainPromise ?? Promise.resolve(),
        this.capacityReconciliationTask ?? Promise.resolve(),
      ]);
    }
    await this.deadlines.settle();
  }
  /** True only after the heap obligation has crossed into durable or terminal receipt state. */
  public async settleAcceptance(participantId: string): Promise<boolean> {
    if (this.greeting(participantId) === undefined) {
      return true;
    }
    await this.settle();
    return this.greetedParticipantIds.has(participantId) ||
      this.receipts.isFencedOrActive(participantId);
  }
  private async drain(): Promise<void> {
    const greetings = this.dependencies.configuration.greetings;
    if (greetings === undefined) {
      return;
    }
    while (!this.closed && !this.dependencies.isMeetingFinishing()) {
      if (this.capacityReconciliationRequired ||
        this.capacityReconciliationTask !== null) {
        this.advanceRequested = true;
        return;
      }
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
  // oxlint-disable-next-line max-lines-per-function, complexity
  private async processGreeting(
    participantId: string,
    priority: ParticipantGreetingPriority,
    greeting: ResolvedParticipantGreeting,
  ): Promise<boolean> {
    if (this.capacityReconciliationRequired ||
      this.capacityReconciliationTask !== null) {
      this.enqueue(participantId, priority);
      return true;
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
    let admissionCohortParticipantIds = this.cohortCandidates(participantId);
    for (;;) {
        const admissionDeadlineParticipantId = this.deadlines.earliestParticipantId(
          admissionCohortParticipantIds,
        ) ?? participantId;
        if (this.scheduling.canStartBeforeDeadline(
          this.deadlines.expiresAtMilliseconds(admissionDeadlineParticipantId),
          this.nowMilliseconds(),
        )) {
          break;
        }
        if (admissionDeadlineParticipantId === participantId) {
          await this.receipts.fenceOnce(participantId);
          this.greetedParticipantIds.add(participantId);
          this.clearTerminalState(participantId);
          return false;
        }
        this.pendingGreetings.delete(admissionDeadlineParticipantId);
        await this.receipts.fenceOnce(admissionDeadlineParticipantId);
        this.greetedParticipantIds.add(admissionDeadlineParticipantId);
        this.clearTerminalState(admissionDeadlineParticipantId);
        admissionCohortParticipantIds = admissionCohortParticipantIds.filter(
          (id) => id !== admissionDeadlineParticipantId,
        );
    }
    const reclaimActive = this.recoveryParticipantIds.delete(participantId);
    const admission = this.preReservedAdmissions.get(participantId) ??
      await reserveGreetingPlaybackAdmission({
      clearTerminal: () => { this.clearTerminalState(participantId); },
      deadlines: this.deadlines,
      markGreeted: () => this.greetedParticipantIds.add(participantId),
      nowMilliseconds: () => this.nowMilliseconds(),
      participantId,
      reclaimActive,
      receipts: this.receipts,
    });
    this.preReservedAdmissions.delete(participantId);
    if (admission === undefined) {
      return false;
    }
    const cohortParticipantIds = admission.providerCommand === undefined
      ? this.hasPreparedIndividualCues(admissionCohortParticipantIds)
        ? [participantId]
        : this.takeCohort(participantId, admissionCohortParticipantIds)
      : [participantId];
    const cohortAdmissions = new Map([[participantId, admission]]);
    for (const cohortParticipantId of cohortParticipantIds.slice(1)) {
      const followerAdmission = await reserveGreetingPlaybackAdmission({
        clearTerminal: () => { this.clearTerminalState(cohortParticipantId); },
        deadlines: this.deadlines,
        markGreeted: () => this.greetedParticipantIds.add(cohortParticipantId),
        nowMilliseconds: () => this.nowMilliseconds(),
        participantId: cohortParticipantId,
        reclaimActive: this.recoveryParticipantIds.delete(cohortParticipantId),
        receipts: this.receipts,
      });
      if (followerAdmission !== undefined) {
        if (followerAdmission.providerCommand !== undefined) {
          // A recovered command is immutable evidence belonging to this participant.
          // It must never be rewritten as a follower of a newly rendered command.
          this.preReservedAdmissions.set(cohortParticipantId, followerAdmission);
          this.capacityExemptParticipantIds.add(cohortParticipantId);
          this.pendingGreetings.enqueue(cohortParticipantId, "high");
          continue;
        }
        cohortAdmissions.set(cohortParticipantId, followerAdmission);
      }
    }
    const reservedParticipantIds = cohortParticipantIds.filter((id) => cohortAdmissions.has(id));
    const recoveredCommand = admission.providerCommand !== undefined;
    const admittedParticipantIds = reservedParticipantIds.filter((id) =>
      this.presentParticipantIds.has(id) &&
      this.deadlines.ensureFresh(id, this.nowMilliseconds())
    );
    await Promise.all(reservedParticipantIds
      .filter((id) => !admittedParticipantIds.includes(id))
      .map((id) => this.receipts.settle(id, "suppressed", "stale")));
    if (!admittedParticipantIds.includes(participantId)) {
      const survivingFollowers = admittedParticipantIds.filter((id) => id !== participantId);
      await Promise.all(survivingFollowers.map((id) =>
        this.receipts.release(id, "unplayed")
      ));
      for (const id of survivingFollowers) {
        this.enqueue(id, "high");
      }
      return false;
    }
    if (!this.deadlines.ensureFresh(participantId, this.nowMilliseconds())) {
      await Promise.all(admittedParticipantIds.map((id) =>
        this.receipts.settle(id, "suppressed", "stale")
      ));
      return false;
    }
    const isCohort = admittedParticipantIds.length > 1;
    const deadlineParticipantId = this.deadlines.earliestParticipantId(
      admittedParticipantIds,
    );
    if (deadlineParticipantId === undefined ||
      !this.scheduling.canStartBeforeDeadline(
        this.deadlines.expiresAtMilliseconds(deadlineParticipantId),
        this.nowMilliseconds(),
      )) {
      await Promise.all(admittedParticipantIds.map((id) =>
        this.receipts.settle(id, "suppressed", "stale")
      ));
      return false;
    }
    const cohortGreeting = admission.providerCommand ?? (!isCohort
      ? greeting
      : resolveParticipantGreetingCohort(
          this.dependencies.configuration,
          admittedParticipantIds,
        ));
    const usesDynamicCohortCommand = isCohort || cohortGreeting.prompt !== greeting.prompt;
    const beginAttempt = this.receipts.beginCohortAttempt(
      admittedParticipantIds,
      cohortGreeting,
      admission.providerCommandId,
    );
    const attemptResult = recoveredCommand
      ? await completedVoid(beginAttempt)
      : await this.deadlines.race(
          deadlineParticipantId,
          beginAttempt,
          () => this.nowMilliseconds(),
        );
    if (attemptResult.status === "expired") {
      for (const id of admittedParticipantIds) {
        this.greetedParticipantIds.add(id);
      }
      void attemptResult.operation.then(
        () => Promise.all(admittedParticipantIds.map((id) =>
          this.receipts.settle(id, "suppressed", "ambiguous")
        )).then(() => null),
        () => Promise.all(admittedParticipantIds.map((id) => this.receipts.fenceOnce(id)))
          .then(() => null),
      ).catch(() => {});
      return false;
    }
    if (recoveredCommand && admission.providerRecoveryDeadlineMilliseconds !== undefined &&
      this.nowMilliseconds() >= admission.providerRecoveryDeadlineMilliseconds) {
      await Promise.all(admittedParticipantIds.map((id) =>
        this.receipts.settle(id, "suppressed", "ambiguous")));
      return false;
    }
    const playbackNotAfterMilliseconds = this.deadlines.expiresAtMilliseconds(
      deadlineParticipantId,
    );
    if (playbackNotAfterMilliseconds === undefined ||
      !this.deadlines.ensureFresh(deadlineParticipantId, this.nowMilliseconds())) {
      await Promise.all(admittedParticipantIds.map((id) =>
        this.receipts.settle(id, "suppressed", "stale")
      ));
      return false;
    }
    this.activeGreetingParticipantId = participantId;
    const playback = this.speak(
      participantId,
      cohortGreeting,
      admission.providerCommandId,
      usesDynamicCohortCommand,
      playbackNotAfterMilliseconds,
    );
    const playbackBound = this.scheduling.beginSlot(
      participantId,
      this.nowMilliseconds(),
      usesDynamicCohortCommand,
    );
    let coordinated;
    try {
      coordinated = await coordinateGreetingPlayback({
        clearTerminal: () => { this.clearTerminalState(participantId); },
        deadlines: this.deadlines,
        dependencies: this.settlementDependencies(),
        deadlineParticipantId,
        markGreeted: () => this.greetedParticipantIds.add(participantId),
        observeFirstAudio: (startedAtMilliseconds) => {
          this.scheduling.observeFirstAudio(startedAtMilliseconds, playbackBound);
        },
        persistFirstAudio: async (startedAtMilliseconds) => {
          for (const id of admittedParticipantIds) {
            if (id !== deadlineParticipantId &&
              !this.deadlines.acceptFirstAudio(id, startedAtMilliseconds)) {
              throw new Error("Greeting cohort member missed the producer deadline");
            }
          }
          await this.receipts.confirmCohortStarted(
            admittedParticipantIds,
            startedAtMilliseconds,
          );
        },
        participantId,
        playback,
        playbackBoundMilliseconds: playbackBound,
        receipts: this.receipts,
        releaseSlot: () => { this.scheduling.releaseSlot(); },
        suppressOverflow: () => { /* explicit bounded cohort admission owns overflow */ },
      });
    } finally {
      if (this.activeGreetingParticipantId === participantId) {
        this.activeGreetingParticipantId = null;
      }
    }
    await this.settleCohortFollowers(
      admittedParticipantIds.slice(1),
      coordinated.status === "outcome" ? coordinated.outcome : "unknown",
      priority,
    );
    return coordinated.status === "terminal"
      ? false
      : this.scheduling.settleOutcome({
          clearTerminal: () => { this.clearTerminalState(participantId); },
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
  private cohortCandidates(leaderParticipantId: string): readonly string[] {
    if (this.capacityExemptParticipantIds.has(leaderParticipantId)) {
      return [leaderParticipantId];
    }
    return [
      leaderParticipantId,
      ...this.pendingGreetings.orderedReady()
        .filter(({ participantId }) =>
          this.presentParticipantIds.has(participantId) &&
          !this.capacityExemptParticipantIds.has(participantId) &&
          this.greeting(participantId) !== undefined
        )
        .slice(0, maximumSupportedCohortSize - 1)
        .map(({ participantId }) => participantId),
    ];
  }

  private takeCohort(
    leaderParticipantId: string,
    waitingParticipantIds: readonly string[],
  ): readonly string[] {
    const waited = new Set(waitingParticipantIds);
    const matching = this.pendingGreetings.orderedReady().filter(({ participantId }) =>
      waited.has(participantId) && this.presentParticipantIds.has(participantId) &&
      !this.capacityExemptParticipantIds.has(participantId) &&
      this.greeting(participantId) !== undefined
    );
    const admitted = matching.slice(0, maximumSupportedCohortSize - 1);
    for (const { participantId } of admitted) {
      this.pendingGreetings.delete(participantId);
    }
    return [leaderParticipantId, ...admitted.map(({ participantId }) => participantId)];
  }

  private hasPreparedIndividualCues(participantIds: readonly string[]): boolean {
    return participantIds.length > 1 && participantIds.every((participantId) =>
      this.scheduling.preparedCue(participantId) !== null
    );
  }

  private async settleCohortFollowers(
    participantIds: readonly string[],
    outcome: GreetingAttemptOutcome,
    priority: ParticipantGreetingPriority,
  ): Promise<void> {
    for (const participantId of participantIds) {
      if (outcome === "played") {
        await this.receipts.settle(participantId, "played");
        this.greetedParticipantIds.add(participantId);
        this.clearTerminalState(participantId);
      } else if (outcome === "busy" || outcome === "unplayed") {
        await this.receipts.release(participantId, outcome);
        this.pendingGreetings.deferRetry(participantId, priority);
      } else {
        await this.receipts.settle(participantId, "suppressed", "ambiguous");
        this.greetedParticipantIds.add(participantId);
        this.clearTerminalState(participantId);
      }
    }
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
      if (this.recoveryParticipantIds.has(participantId)) {
        this.deadlines.restore(participantId, occurredAt, this.nowMilliseconds());
      } else {
        this.deadlines.start(participantId, occurredAt, this.nowMilliseconds());
      }
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
    this.capacityExemptParticipantIds.delete(participantId);
    this.deadlines.clear(participantId);
    this.scheduling.forget(participantId);
  }
  /** Batch restoration reconciles durable state before any due greeting can drain. */
  private requestCapacityReconciliation(): void {
    const supported = this.pendingGreetings.orderedReady().filter(({ participantId }) =>
      this.presentParticipantIds.has(participantId) &&
      !this.capacityExemptParticipantIds.has(participantId) &&
      this.greeting(participantId) !== undefined
    );
    if (this.capacityReconciledGeneration >= this.capacityReconciliationGeneration) {
      this.capacityReconciliationRequired = false;
      return;
    }
    this.capacityReconciliationRequired = true;
    if (this.capacityReconciliationTask !== null || this.closed) {
      return;
    }
    const orderedParticipantIds = supported.map(({ participantId }) => participantId);
    const generation = this.capacityReconciliationGeneration;
    const task = this.reconcileReadyCapacity(orderedParticipantIds, generation);
    this.capacityReconciliationTask = task;
    this.deadlines.track(task);
  }
  private async reconcileReadyCapacity(
    orderedParticipantIds: readonly string[],
    generation: number,
  ): Promise<void> {
    let succeeded = false;
    try {
      const result = await this.receipts.reconcileCapacity(
        orderedParticipantIds,
        maximumSupportedCohortSize,
      );
      if (this.closed) {
        return;
      }
      for (const participantId of result.commandedSubjectIds) {
        this.capacityExemptParticipantIds.add(participantId);
        this.pendingGreetings.enqueue(participantId, "high");
      }
      for (const participantId of result.suppressedSubjectIds) {
        this.markCapacityTerminal(participantId);
      }
      for (const participantId of result.terminalSubjectIds) {
        this.pendingGreetings.delete(participantId);
        this.greetedParticipantIds.add(participantId);
        this.clearTerminalState(participantId);
      }
      this.capacityReconciledGeneration = Math.max(
        this.capacityReconciledGeneration,
        generation,
      );
      succeeded = true;
    } catch (error) {
      this.dependencies.logger.warn("Participant greeting capacity reconciliation failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        meetingId: this.dependencies.meetingId,
        reason: "join-cohort-capacity",
      });
    } finally {
      this.capacityReconciliationTask = null;
      if (succeeded && !this.closed) {
        this.requestCapacityReconciliation();
        this.tryAdvance();
      }
    }
  }
  private markCapacityTerminal(participantId: string): void {
    this.pendingGreetings.delete(participantId);
    this.recoveryParticipantIds.delete(participantId);
    this.greetedParticipantIds.add(participantId);
    this.clearTerminalState(participantId);
    this.dependencies.logger.warn("Participant greeting suppressed before admission", {
      meetingId: this.dependencies.meetingId,
      participantId,
      reason: "join-cohort-capacity",
    });
  }
  private speak(
    participantId: string,
    greeting: ResolvedParticipantGreeting,
    providerCommandId: string,
    isCohort: boolean,
    playbackNotAfterMilliseconds: number,
  ): ParticipantGreetingPlayback {
    const retryCount = this.scheduling.retryCount(participantId);
    const turnId = retryCount === 0
      ? `participant-greeting:${participantId}`
      : `participant-greeting:${participantId}:retry-${retryCount}`;
    return playParticipantGreeting({
      configuration: this.dependencies.configuration,
      fallbackPreparedCue: isCohort || this.profile(participantId) !== undefined
        ? selectParticipantGreetingAnonymousCue(
            this.dependencies.configuration,
            greeting.locale,
            this.dependencies.meetingId,
            participantId,
          )
        : null,
      greeting,
      isNamed: !isCohort && this.profile(participantId) !== undefined,
      logger: this.dependencies.logger,
      meetingId: this.dependencies.meetingId,
      nowMilliseconds: () => this.nowMilliseconds(),
      playbackNotAfterMilliseconds,
      observedLatencyMilliseconds: () =>
        this.observedGreetingLatencyMilliseconds(participantId),
      participantId,
      providerCommandId,
      preparedCue: isCohort ? null : this.scheduling.preparedCue(participantId),
      shouldStop: () => this.shouldStopGreeting(participantId),
      turnId,
    });
  }
  private preemptActiveGreeting(): void {
    const participantId = this.activeGreetingParticipantId;
    if (participantId === null) {
      return;
    }
    const cancellation = cancelParticipantGreetingPlayback(
      this.dependencies.configuration,
      this.dependencies.logger,
      this.dependencies.meetingId,
      participantId,
      this.nowMilliseconds(),
    );
    this.deadlines.track(cancellation);
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
