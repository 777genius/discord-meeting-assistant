import type {
  LiveRuntimeTimer,
  LiveRuntimeTimerHandle,
} from "./contracts.js";

const joinToFirstAudioDeadlineMilliseconds = 5_000;
const maximumFutureJoinSkewMilliseconds = 1_000;
export const participantGreetingDeadlineReason = "join-to-first-audio-deadline";

export type ParticipantGreetingFreshness =
  | { readonly anchorMilliseconds: number; readonly remainingMilliseconds: number;
      readonly status: "fresh" }
  | { readonly status: "terminal" };

/** Producer-time freshness with a bounded allowance for forward clock skew. */
export function participantGreetingFreshness(
  occurredAt: string,
  observedAtMilliseconds: number,
): ParticipantGreetingFreshness {
  const occurredAtMilliseconds = Date.parse(occurredAt);
  if (!Number.isSafeInteger(observedAtMilliseconds) || observedAtMilliseconds < 0 ||
    !Number.isSafeInteger(occurredAtMilliseconds) || occurredAtMilliseconds < 0 ||
    occurredAtMilliseconds - observedAtMilliseconds > maximumFutureJoinSkewMilliseconds) {
    return { status: "terminal" };
  }
  const anchorMilliseconds = Math.min(occurredAtMilliseconds, observedAtMilliseconds);
  const remainingMilliseconds = joinToFirstAudioDeadlineMilliseconds -
    (observedAtMilliseconds - anchorMilliseconds);
  return remainingMilliseconds <= 0
    ? { status: "terminal" }
    : { anchorMilliseconds, remainingMilliseconds, status: "fresh" };
}

interface Deadline {
  readonly anchorMilliseconds: number;
  readonly expires: Promise<void>;
  readonly handle: LiveRuntimeTimerHandle;
  expired: boolean;
}

export class ParticipantGreetingDeadlines {
  private readonly deadlines = new Map<string, Deadline>();
  private readonly terminalTasks = new Set<Promise<void>>();

  public constructor(
    private readonly timer: LiveRuntimeTimer,
    private readonly onExpired: (participantId: string) => void,
  ) {}

  public start(
    participantId: string,
    occurredAt: string,
    observedAtMilliseconds: number,
  ): ParticipantGreetingFreshness {
    const freshness = participantGreetingFreshness(occurredAt, observedAtMilliseconds);
    if (freshness.status === "terminal") {
      this.onExpired(participantId);
      return freshness;
    }
    let expire!: () => void;
    const expires = new Promise<void>((resolve) => {
      expire = resolve;
    });
    const deadline: Deadline = {
      anchorMilliseconds: freshness.anchorMilliseconds,
      expired: false,
      expires,
      handle: this.timer.schedule(freshness.remainingMilliseconds, () => {
        deadline.expired = true;
        expire();
        this.onExpired(participantId);
      }),
    };
    this.deadlines.set(participantId, deadline);
    return freshness;
  }

  public clear(participantId: string): void {
    const deadline = this.deadlines.get(participantId);
    if (deadline !== undefined) {
      this.timer.cancel(deadline.handle);
      this.deadlines.delete(participantId);
    }
  }

  public clearAll(): void {
    for (const participantId of this.deadlines.keys()) {
      this.clear(participantId);
    }
  }

  public has(participantId: string): boolean {
    return this.deadlines.has(participantId);
  }

  public observedLatencyMilliseconds(participantId: string, nowMilliseconds: number): number {
    const anchorMilliseconds = this.deadlines.get(participantId)?.anchorMilliseconds;
    return anchorMilliseconds === undefined ? 0 : Math.max(0, nowMilliseconds - anchorMilliseconds);
  }

  public async race<T>(participantId: string, operation: Promise<T>): Promise<
    | { readonly status: "completed"; readonly value: T }
    | { readonly operation: Promise<T>; readonly status: "expired" }
  > {
    const deadline = this.deadlines.get(participantId);
    if (deadline === undefined || deadline.expired) {
      return { operation, status: "expired" };
    }
    return Promise.race([
      operation.then((value) => ({ status: "completed" as const, value })),
      deadline.expires.then(() => ({ operation, status: "expired" as const })),
    ]);
  }

  public track(task: Promise<void>): void {
    this.terminalTasks.add(task);
    void task.finally(() => {
      this.terminalTasks.delete(task);
    });
  }

  public async settle(): Promise<void> {
    while (this.terminalTasks.size > 0) {
      await Promise.all(this.terminalTasks);
    }
  }
}
