import type {
  LiveRuntimeTimer,
  LiveRuntimeTimerHandle,
} from "./contracts.js";

const joinToFirstAudioDeadlineMilliseconds = 5_000;
export const participantGreetingDeadlineReason = "join-to-first-audio-deadline";

interface Deadline {
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

  public start(participantId: string): void {
    let expire!: () => void;
    const expires = new Promise<void>((resolve) => {
      expire = resolve;
    });
    const deadline: Deadline = {
      expired: false,
      expires,
      handle: this.timer.schedule(joinToFirstAudioDeadlineMilliseconds, () => {
        deadline.expired = true;
        expire();
        this.onExpired(participantId);
      }),
    };
    this.deadlines.set(participantId, deadline);
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
