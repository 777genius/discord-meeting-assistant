const maximumConsecutiveHighPrioritySelections = 3;

export type ParticipantGreetingPriority = "high" | "initial";

export interface PendingParticipantGreeting {
  readonly participantId: string;
  readonly priority: ParticipantGreetingPriority;
}

/** Two-lane FIFO admission with tick-gated retries and bounded initial fairness. */
export class ParticipantGreetingQueue {
  private consecutiveHighPrioritySelections = 0;
  private readonly deferredRetries = new Map<string, ParticipantGreetingPriority>();
  private readonly highPriorityParticipantIds = new Set<string>();
  private readonly initialParticipantIds = new Set<string>();

  public enqueue(
    participantId: string,
    priority: ParticipantGreetingPriority,
  ): void {
    if (this.deferredRetries.has(participantId)) {
      return;
    }
    this.enqueueReady(participantId, priority);
  }

  public deferRetry(
    participantId: string,
    priority: ParticipantGreetingPriority,
  ): void {
    this.highPriorityParticipantIds.delete(participantId);
    this.initialParticipantIds.delete(participantId);
    if (!this.deferredRetries.has(participantId)) {
      this.deferredRetries.set(participantId, priority);
    }
  }

  public releaseDeferredRetries(): void {
    const retries = [...this.deferredRetries];
    this.deferredRetries.clear();
    for (const [participantId, priority] of retries) {
      this.enqueueReady(participantId, priority);
    }
  }

  public delete(participantId: string): void {
    this.deferredRetries.delete(participantId);
    this.highPriorityParticipantIds.delete(participantId);
    this.initialParticipantIds.delete(participantId);
  }

  public clear(): void {
    this.consecutiveHighPrioritySelections = 0;
    this.deferredRetries.clear();
    this.highPriorityParticipantIds.clear();
    this.initialParticipantIds.clear();
  }

  public hasReady(): boolean {
    return this.highPriorityParticipantIds.size > 0 || this.initialParticipantIds.size > 0;
  }

  public takeNext(): PendingParticipantGreeting | undefined {
    if (
      this.highPriorityParticipantIds.size > 0 &&
      (this.initialParticipantIds.size === 0 ||
        this.consecutiveHighPrioritySelections < maximumConsecutiveHighPrioritySelections)
    ) {
      const participantId = this.highPriorityParticipantIds.values().next().value;
      if (participantId !== undefined) {
        this.highPriorityParticipantIds.delete(participantId);
        this.consecutiveHighPrioritySelections += 1;
        return { participantId, priority: "high" };
      }
    }

    const participantId = this.initialParticipantIds.values().next().value;
    if (participantId === undefined) {
      return undefined;
    }
    this.initialParticipantIds.delete(participantId);
    this.consecutiveHighPrioritySelections = 0;
    return { participantId, priority: "initial" };
  }

  private enqueueReady(
    participantId: string,
    priority: ParticipantGreetingPriority,
  ): void {
    if (priority === "high") {
      this.initialParticipantIds.delete(participantId);
      this.highPriorityParticipantIds.add(participantId);
      return;
    }
    if (!this.highPriorityParticipantIds.has(participantId)) {
      this.initialParticipantIds.add(participantId);
    }
  }
}
