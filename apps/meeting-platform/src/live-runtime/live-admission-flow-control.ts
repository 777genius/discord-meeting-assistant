import type {
  LiveRuntimeClock,
  LiveRuntimeTimer,
  LiveRuntimeTimerHandle,
} from "./contracts.js";
import {
  systemLiveRuntimeClock,
  systemLiveRuntimeTimer,
} from "./runtime-clock.js";

export type LiveSessionRelease = () => void;

interface GlobalPacketCapacityWaiter {
  readonly packetCount: number;
  readonly resolve: (reserved: boolean) => void;
  readonly signal: AbortSignal;
  readonly timeout: LiveRuntimeTimerHandle;
}

interface LiveSessionWaiter {
  readonly onAbort: () => void;
  readonly resolve: (release: LiveSessionRelease | null) => void;
  readonly signal: AbortSignal;
}

/** Runtime-wide FIFO packet budget shared by every meeting and speaker. */
export class GlobalPacketFlowControl {
  private reservedPackets = 0;
  private readonly waiters: GlobalPacketCapacityWaiter[] = [];

  public constructor(
    public readonly maximumPackets: number,
    private readonly clock: LiveRuntimeClock = systemLiveRuntimeClock,
    private readonly timer: LiveRuntimeTimer = systemLiveRuntimeTimer,
  ) {
    if (!Number.isSafeInteger(maximumPackets) || maximumPackets < 1) {
      throw new RangeError("maximum global live packets must be a positive integer");
    }
  }

  public reserve(
    packetCount: number,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(packetCount) || packetCount < 1) {
      throw new RangeError("global packet reservation must be a positive integer");
    }
    if (signal.aborted || packetCount > this.maximumPackets) {
      return Promise.resolve(false);
    }
    if (this.waiters.length === 0 && this.canReserve(packetCount)) {
      this.reservedPackets += packetCount;
      return Promise.resolve(true);
    }
    const remainingMs = deadlineMs - this.clock.nowMilliseconds();
    if (remainingMs <= 0) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let waiter!: GlobalPacketCapacityWaiter;
      const finish = (reserved: boolean): void => {
        signal.removeEventListener("abort", onAbort);
        this.timer.cancel(waiter.timeout);
        resolve(reserved);
      };
      const onAbort = () => {
        if (this.removeWaiter(waiter)) {
          finish(false);
          this.admitWaiters();
        }
      };
      waiter = {
        packetCount,
        resolve: finish,
        signal,
        timeout: this.timer.schedule(remainingMs, () => {
          if (this.removeWaiter(waiter)) {
            finish(false);
            this.admitWaiters();
          }
        }),
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  public release(packetCount: number): void {
    if (!Number.isSafeInteger(packetCount) || packetCount < 1) {
      throw new RangeError("global packet release must be a positive integer");
    }
    this.reservedPackets -= packetCount;
    if (this.reservedPackets < 0) {
      throw new Error("global live packet budget release invariant violated");
    }
    this.admitWaiters();
  }

  private canReserve(packetCount: number): boolean {
    return this.reservedPackets + packetCount <= this.maximumPackets;
  }

  private admitWaiters(): void {
    for (;;) {
      const waiter = this.waiters[0];
      if (waiter === undefined || !this.canReserve(waiter.packetCount)) {
        return;
      }
      this.waiters.shift();
      if (waiter.signal.aborted) {
        waiter.resolve(false);
        continue;
      }
      this.reservedPackets += waiter.packetCount;
      waiter.resolve(true);
    }
  }

  private removeWaiter(waiter: GlobalPacketCapacityWaiter): boolean {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) {
      return false;
    }
    this.waiters.splice(index, 1);
    return true;
  }
}

/** Process-local FIFO admission for provider WebSocket sessions. */
export class LiveSessionAdmission {
  private availableSlots: number;
  private readonly waiters: LiveSessionWaiter[] = [];

  public constructor(maximumConcurrentSessions: number) {
    this.availableSlots = maximumConcurrentSessions;
  }

  public acquire(signal: AbortSignal): Promise<LiveSessionRelease | null> {
    if (signal.aborted) {
      return Promise.resolve(null);
    }
    if (this.availableSlots > 0) {
      this.availableSlots -= 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve) => {
      let waiter!: LiveSessionWaiter;
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) {
          return;
        }
        this.waiters.splice(index, 1);
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      };
      waiter = { onAbort, resolve, signal };
      this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private releaseOnce(): LiveSessionRelease {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.releaseNext();
    };
  }

  private releaseNext(): void {
    for (;;) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.availableSlots += 1;
        return;
      }
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.resolve(null);
        continue;
      }
      waiter.resolve(this.releaseOnce());
      return;
    }
  }
}
