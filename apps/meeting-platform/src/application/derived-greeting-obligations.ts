import type { DerivedLiveLifecycleEvent } from "./recording-ingress.js";

export interface DerivedGreetingObligation {
  readonly eventId: string;
  readonly memoryHumanObservation?: {
    readonly actorId: string;
    readonly producerRevision: string;
  };
  readonly notAfterMilliseconds: number;
  readonly occurredAt: string;
  readonly participantId: string;
  readonly recordingId: string;
}

export interface DerivedGreetingObligationPort {
  accept(obligation: DerivedGreetingObligation): Promise<void>;
  listPending(): Promise<readonly DerivedGreetingObligation[]>;
  markDelivered(eventId: string): Promise<void>;
  markExpired(eventId: string): Promise<void>;
}

interface DerivedGreetingLivePort {
  acceptLifecycle(
    event: DerivedLiveLifecycleEvent,
  ): void | "accepted" | "retry" | Promise<void | "accepted" | "retry">;
}

interface DerivedGreetingDispatcherDependencies {
  readonly live: DerivedGreetingLivePort;
  readonly nowMilliseconds: () => number;
  readonly obligations: DerivedGreetingObligationPort;
  readonly recordFailure: (recordingId: string, error: unknown) => void;
}

/** Replays only the normalized, deadline-bound participant greeting effect. */
export class DerivedGreetingObligationDispatcher {
  private dispatchPromise: Promise<{ delivered: number; expired: number; failed: number }>
    | null = null;

  public constructor(private readonly dependencies: DerivedGreetingDispatcherDependencies) {}

  public dispatchPending(): Promise<{
    readonly delivered: number;
    readonly expired: number;
    readonly failed: number;
  }> {
    this.dispatchPromise ??= this.dispatchPendingOnce().finally(() => {
      this.dispatchPromise = null;
    });
    return this.dispatchPromise;
  }

  public async deliver(
    obligation: DerivedGreetingObligation,
  ): Promise<"delivered" | "expired" | "failed"> {
    const observedAtMilliseconds = this.dependencies.nowMilliseconds();
    if (!Number.isSafeInteger(observedAtMilliseconds) || observedAtMilliseconds < 0) {
      throw new Error("derived greeting obligation clock is unavailable");
    }
    if (observedAtMilliseconds >= obligation.notAfterMilliseconds) {
      await this.dependencies.obligations.markExpired(obligation.eventId);
      return "expired";
    }
    try {
      const outcome = await Promise.resolve(this.dependencies.live.acceptLifecycle({
        occurredAt: obligation.occurredAt,
        ...(obligation.memoryHumanObservation === undefined
          ? {}
          : { memoryHumanObservation: obligation.memoryHumanObservation }),
        participantId: obligation.participantId,
        recordingId: obligation.recordingId,
        type: "participant.joined",
      }));
      if (outcome === "retry") {
        return "failed";
      }
      await this.dependencies.obligations.markDelivered(obligation.eventId);
      return "delivered";
    } catch (error) {
      this.dependencies.recordFailure(obligation.recordingId, error);
      return "failed";
    }
  }

  private async dispatchPendingOnce(): Promise<{
    readonly delivered: number;
    readonly expired: number;
    readonly failed: number;
  }> {
    let delivered = 0;
    let expired = 0;
    let failed = 0;
    for (const obligation of await this.dependencies.obligations.listPending()) {
      const outcome = await this.deliver(obligation);
      if (outcome === "delivered") {
        delivered += 1;
      } else if (outcome === "expired") {
        expired += 1;
      } else {
        failed += 1;
      }
    }
    return { delivered, expired, failed };
  }
}
