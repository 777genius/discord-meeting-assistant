import type {
  LiveRuntimeTimer,
  LiveRuntimeTimerHandle,
} from "./contracts.js";

const joinToFirstAudioDeadlineMilliseconds = 5_000;
const maximumFutureJoinSkewMilliseconds = 1_000;
export const participantGreetingDeadlineReason = "join-to-first-audio-deadline";

export type ParticipantGreetingFreshness =
  | { readonly anchorMilliseconds: number; readonly expiresAtMilliseconds: number;
      readonly remainingMilliseconds: number; readonly status: "fresh" }
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
  const expiresAtMilliseconds = anchorMilliseconds + joinToFirstAudioDeadlineMilliseconds;
  const remainingMilliseconds = expiresAtMilliseconds - observedAtMilliseconds;
  return remainingMilliseconds <= 0
    ? { status: "terminal" }
    : { anchorMilliseconds, expiresAtMilliseconds, remainingMilliseconds, status: "fresh" };
}

interface Deadline {
  accepted: boolean;
  readonly anchorMilliseconds: number;
  readonly expiresAtMilliseconds: number;
  readonly expires: Promise<void>;
  readonly handle: LiveRuntimeTimerHandle;
  expired: boolean;
  readonly resolveExpiration: () => void;
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
    let resolveExpiration!: () => void;
    const expires = new Promise<void>((resolve) => {
      resolveExpiration = resolve;
    });
    const deadline: Deadline = {
      accepted: false,
      anchorMilliseconds: freshness.anchorMilliseconds,
      expiresAtMilliseconds: freshness.expiresAtMilliseconds,
      expired: false,
      expires,
      handle: this.timer.schedule(freshness.remainingMilliseconds, () => {
        this.expire(participantId, deadline);
      }),
      resolveExpiration,
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

  /** Wakes in-flight races without treating lifecycle cancellation as expiry. */
  public cancel(participantId: string): void {
    const deadline = this.deadlines.get(participantId);
    if (deadline !== undefined) {
      this.cancelDeadline(participantId, deadline);
    }
  }

  public cancelAll(): void {
    for (const [participantId, deadline] of this.deadlines) {
      this.cancelDeadline(participantId, deadline);
    }
  }

  public has(participantId: string): boolean {
    return this.deadlines.has(participantId);
  }

  /** Absolute producer-time admission check; the timer is only a wake-up. */
  public ensureFresh(participantId: string, observedAtMilliseconds: number): boolean {
    const deadline = this.deadlines.get(participantId);
    if (deadline === undefined || deadline.expired) {
      return false;
    }
    if (!Number.isSafeInteger(observedAtMilliseconds) || observedAtMilliseconds < 0 ||
      observedAtMilliseconds >= deadline.expiresAtMilliseconds) {
      this.expire(participantId, deadline);
      return false;
    }
    return true;
  }

  /** Stops the deadline only for provider-confirmed audio within the absolute budget. */
  public acceptFirstAudio(participantId: string, startedAtMilliseconds: number): boolean {
    const deadline = this.deadlines.get(participantId);
    if (deadline === undefined || deadline.expired ||
      !Number.isSafeInteger(startedAtMilliseconds) ||
      startedAtMilliseconds < deadline.anchorMilliseconds ||
      startedAtMilliseconds >= deadline.expiresAtMilliseconds) {
      if (deadline !== undefined) {
        this.expire(participantId, deadline);
      }
      return false;
    }
    if (!deadline.accepted) {
      deadline.accepted = true;
      this.timer.cancel(deadline.handle);
    }
    return true;
  }

  public isExpired(participantId: string, observedAtMilliseconds: number): boolean {
    return !this.ensureFresh(participantId, observedAtMilliseconds);
  }

  public observedLatencyMilliseconds(participantId: string, nowMilliseconds: number): number {
    const anchorMilliseconds = this.deadlines.get(participantId)?.anchorMilliseconds;
    return anchorMilliseconds === undefined ? 0 : Math.max(0, nowMilliseconds - anchorMilliseconds);
  }

  public async race<T>(
    participantId: string,
    operation: Promise<T>,
    nowMilliseconds: () => number,
  ): Promise<
    | { readonly status: "completed"; readonly value: T }
    | { readonly operation: Promise<T>; readonly status: "expired" }
  > {
    const deadline = this.deadlines.get(participantId);
    if (deadline === undefined || !this.ensureFresh(participantId, nowMilliseconds())) {
      return { operation, status: "expired" };
    }
    const result = await Promise.race([
      operation.then((value) => ({ status: "completed" as const, value })),
      deadline.expires.then(() => ({ operation, status: "expired" as const })),
    ]);
    if (result.status === "completed" && !this.ensureFresh(participantId, nowMilliseconds())) {
      return { operation: Promise.resolve(result.value), status: "expired" };
    }
    return result;
  }

  private expire(participantId: string, deadline: Deadline): void {
    if (deadline.expired || deadline.accepted) {
      return;
    }
    deadline.expired = true;
    deadline.resolveExpiration();
    this.onExpired(participantId);
  }

  private cancelDeadline(participantId: string, deadline: Deadline): void {
    this.timer.cancel(deadline.handle);
    deadline.expired = true;
    deadline.resolveExpiration();
    this.deadlines.delete(participantId);
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
