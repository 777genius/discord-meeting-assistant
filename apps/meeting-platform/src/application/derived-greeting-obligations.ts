import type {
  DerivedLiveLifecycleEvent,
  RecordingLifecycleCommand,
} from "./recording-ingress.js";

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

export interface DerivedGreetingObligationPlan {
  readonly initialHumanParticipantIds: readonly string[] | null;
  readonly obligations: readonly DerivedGreetingObligation[];
}

export function deriveGreetingObligationPlan(
  event: RecordingLifecycleCommand,
): DerivedGreetingObligationPlan {
  if (event.schemaVersion === 1) {
    return {
      initialHumanParticipantIds: event.type === "meeting.started" ? [] : null,
      obligations: [],
    };
  }
  if (event.type === "meeting.started") {
    const initialHumanParticipantIds = event.actors
      .filter((actor) => actor.kind === "human")
      .map((actor) => actor.actorId)
      .toSorted();
    return {
      initialHumanParticipantIds,
      obligations: initialHumanParticipantIds.map((actorId) =>
        createGreetingObligation({
          actorId,
          event,
          eventId: `${event.eventId}:initial:${actorId}`,
        })
      ),
    };
  }
  if (event.type !== "participant.joined" || event.actor.kind !== "human") {
    return { initialHumanParticipantIds: null, obligations: [] };
  }
  return {
    initialHumanParticipantIds: null,
    obligations: [createGreetingObligation({
      actorId: event.actor.actorId,
      event,
      eventId: event.eventId,
    })],
  };
}

function createGreetingObligation(input: {
  readonly actorId: string;
  readonly event: RecordingLifecycleCommand & { readonly schemaVersion: 2 | 3 };
  readonly eventId: string;
}): DerivedGreetingObligation {
  const { actorId, event, eventId } = input;
  const occurredAtMilliseconds = Date.parse(event.occurredAt);
  if (!Number.isSafeInteger(occurredAtMilliseconds) || occurredAtMilliseconds < 0) {
    throw new Error("greeting obligation occurrence is invalid");
  }
  return {
    eventId,
    ...(event.schemaVersion !== 3
      ? {}
      : { memoryHumanObservation: {
          actorId,
          producerRevision: event.producerRevision,
        } }),
    notAfterMilliseconds: occurredAtMilliseconds + 5_000,
    // The public lifecycle contract may retain precision finer than the
    // runtime clock. The derived ledger uses one canonical millisecond anchor
    // for both columns so valid contract precision cannot contradict itself.
    occurredAt: new Date(occurredAtMilliseconds).toISOString(),
    participantId: actorId,
    recordingId: event.recordingId,
  };
}

export interface DerivedGreetingTerminalRetentionPort {
  purgeTerminal(input: {
    readonly limit: number;
    readonly terminalBeforeMilliseconds: number;
  }): Promise<{
    readonly capacityAdmissionsDeleted: number;
    readonly meetingsProcessed: number;
    readonly obligationsDeleted: number;
  }>;
}

export const derivedGreetingTerminalRetentionMilliseconds = 90 * 24 * 60 * 60 * 1_000;

/** Bounded maintenance for operational rows; provider-start evidence is outside this port. */
export class DerivedGreetingTerminalRetention {
  public constructor(private readonly dependencies: {
    readonly nowMilliseconds: () => number;
    readonly retention: DerivedGreetingTerminalRetentionPort;
  }) {}

  public execute(limit = 100): Promise<{
    readonly capacityAdmissionsDeleted: number;
    readonly meetingsProcessed: number;
    readonly obligationsDeleted: number;
  }> {
    const nowMilliseconds = this.dependencies.nowMilliseconds();
    if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds <
      derivedGreetingTerminalRetentionMilliseconds) {
      throw new Error("derived greeting retention clock is unavailable");
    }
    return this.dependencies.retention.purgeTerminal({
      limit,
      terminalBeforeMilliseconds: nowMilliseconds -
        derivedGreetingTerminalRetentionMilliseconds,
    });
  }
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
