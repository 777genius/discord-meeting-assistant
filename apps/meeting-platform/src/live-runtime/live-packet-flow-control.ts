import type {
  LivePacketFlowControl,
  LiveRuntimeClock,
  LiveRuntimeTimer,
  LiveRuntimeTimerHandle,
} from "./contracts.js";
import {
  systemLiveRuntimeClock,
  systemLiveRuntimeTimer,
} from "./runtime-clock.js";

export type { LivePacketFlowControl } from "./contracts.js";

const defaultMaximumQueuedPacketsPerSpeaker = 512;
const maximumQueuedPacketsPerSpeaker = 512;
const defaultMaximumQueuedPacketsGlobally = 4_096;
const maximumQueuedPacketsGlobally = 65_536;
const defaultMaximumConcurrentLiveSessions = 3;
const maximumConcurrentLiveSessions = 10;
const defaultPacketBackpressureTimeoutMs = 2_000;
const minimumPacketBackpressureTimeoutMs = 100;
const maximumPacketBackpressureTimeoutMs = 30_000;
// Let the source clock lead the wall clock slightly for normal network
// jitter, but never burst arbitrary backlogs into the provider.
const maximumLivePacketLeadMs = 250;

export interface ResolvedLivePacketFlowControl {
  readonly maximumConcurrentSessions: number;
  readonly maximumQueuedPacketsGlobally: number;
  readonly maximumQueuedPacketsPerSpeaker: number;
  readonly packetBackpressureTimeoutMs: number;
}

export type LiveSessionRelease = () => void;

interface PacketCapacityWaiter {
  wake(): void;
}

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

export function resolveLivePacketFlowControl(
  value: LivePacketFlowControl | undefined,
): ResolvedLivePacketFlowControl {
  const maximumConcurrentSessions = value?.maximumConcurrentSessions ??
    defaultMaximumConcurrentLiveSessions;
  if (
    !Number.isSafeInteger(maximumConcurrentSessions) ||
    maximumConcurrentSessions < 1 ||
    maximumConcurrentSessions > maximumConcurrentLiveSessions
  ) {
    throw new RangeError(
      `maximumConcurrentSessions must be between 1 and ${maximumConcurrentLiveSessions}`,
    );
  }
  const maximumQueuedPackets = value?.maximumQueuedPacketsPerSpeaker ??
    defaultMaximumQueuedPacketsPerSpeaker;
  if (
    !Number.isSafeInteger(maximumQueuedPackets) ||
    maximumQueuedPackets < 1 ||
    maximumQueuedPackets > maximumQueuedPacketsPerSpeaker
  ) {
    throw new RangeError(
      `maximumQueuedPacketsPerSpeaker must be between 1 and ${maximumQueuedPacketsPerSpeaker}`,
    );
  }
  const maximumGlobalPackets = resolveMaximumGlobalPackets(
    value?.maximumQueuedPacketsGlobally,
  );
  const packetBackpressureTimeoutMs = value?.packetBackpressureTimeoutMs ??
    defaultPacketBackpressureTimeoutMs;
  if (
    !Number.isSafeInteger(packetBackpressureTimeoutMs) ||
    packetBackpressureTimeoutMs < minimumPacketBackpressureTimeoutMs ||
    packetBackpressureTimeoutMs > maximumPacketBackpressureTimeoutMs
  ) {
    throw new RangeError(
      `packetBackpressureTimeoutMs must be between ${minimumPacketBackpressureTimeoutMs} and ${maximumPacketBackpressureTimeoutMs}`,
    );
  }
  return {
    maximumConcurrentSessions,
    maximumQueuedPacketsGlobally: maximumGlobalPackets,
    maximumQueuedPacketsPerSpeaker: maximumQueuedPackets,
    packetBackpressureTimeoutMs,
  };
}

function resolveMaximumGlobalPackets(value: number | undefined): number {
  const resolved = value ?? defaultMaximumQueuedPacketsGlobally;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > maximumQueuedPacketsGlobally
  ) {
    throw new RangeError(
      `maximumQueuedPacketsGlobally must be between 1 and ${maximumQueuedPacketsGlobally}`,
    );
  }
  return resolved;
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

/** Bounded per-speaker queue and post-durability admission wait. */
export class SpeakerPacketFlowControl {
  private readonly abortController = new AbortController();
  private readonly capacityWaiters: PacketCapacityWaiter[] = [];
  private pendingAdmissionPackets = 0;
  private queuedPackets = 0;

  public constructor(
    public readonly maximumQueuedPackets: number,
    private readonly clock: LiveRuntimeClock = systemLiveRuntimeClock,
    private readonly timer: LiveRuntimeTimer = systemLiveRuntimeTimer,
  ) {
    if (!Number.isSafeInteger(maximumQueuedPackets) || maximumQueuedPackets < 1) {
      throw new RangeError("maximumQueuedPackets must be a positive integer");
    }
  }

  public get pendingAdmissionPacketCount(): number {
    return this.pendingAdmissionPackets;
  }

  public get queuedPacketCount(): number {
    return this.queuedPackets;
  }

  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  public tryReserveAdmission(packetCount: number): boolean {
    if (!Number.isSafeInteger(packetCount) || packetCount < 1) {
      throw new RangeError("packetCount must be a positive integer");
    }
    if (this.pendingAdmissionPackets + packetCount > this.maximumQueuedPackets) {
      return false;
    }
    this.pendingAdmissionPackets += packetCount;
    return true;
  }

  public releaseAdmission(packetCount: number): void {
    this.pendingAdmissionPackets -= packetCount;
  }

  public async waitForQueueSlot(
    deadlineMs: number,
    isClosed: () => boolean,
  ): Promise<boolean> {
    if (isClosed() || this.queuedPackets < this.maximumQueuedPackets) {
      return !isClosed();
    }
    const remainingMs = deadlineMs - this.clock.nowMilliseconds();
    if (remainingMs <= 0) {
      return false;
    }
    let waiter!: PacketCapacityWaiter;
    const capacityAvailable = new Promise<boolean>((resolve) => {
      waiter = {
        wake: () => {
          resolve(true);
        },
      };
      this.capacityWaiters.push(waiter);
    });
    let timeout!: LiveRuntimeTimerHandle;
    const timeoutElapsed = new Promise<boolean>((resolve) => {
      timeout = this.timer.schedule(remainingMs, () => {
        resolve(false);
      });
    });
    if (isClosed()) {
      waiter.wake();
    }
    const available = await Promise.race([capacityAvailable, timeoutElapsed]);
    this.timer.cancel(timeout);
    const index = this.capacityWaiters.indexOf(waiter);
    if (index >= 0) {
      this.capacityWaiters.splice(index, 1);
    }
    return available && !isClosed() && this.queuedPackets < this.maximumQueuedPackets;
  }

  public reserveQueueSlot(): void {
    if (this.queuedPackets >= this.maximumQueuedPackets) {
      throw new Error("live packet queue capacity invariant violated");
    }
    this.queuedPackets += 1;
  }

  public releaseQueueSlot(): void {
    this.queuedPackets -= 1;
    this.capacityWaiters.shift()?.wake();
  }

  public cancel(): void {
    this.abortController.abort();
    const waiters = this.capacityWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.wake();
    }
  }
}

/** Paces one speaker's Opus stream against its source timeline. */
export class SourceTimelinePacer {
  private nextPermittedPacketAtMs = 0;

  public constructor(
    private readonly clock: LiveRuntimeClock = systemLiveRuntimeClock,
    private readonly timer: LiveRuntimeTimer = systemLiveRuntimeTimer,
  ) {}

  public async waitForPacketTime(
    meetingStartedAtMs: number,
    relativeTimeMs: number,
    signal: AbortSignal,
  ): Promise<number | null> {
    const earliestPacketAtMs = Math.max(
      meetingStartedAtMs + relativeTimeMs - maximumLivePacketLeadMs,
      this.nextPermittedPacketAtMs,
    );
    return (await waitForLivePacketTime(
      earliestPacketAtMs,
      signal,
      this.clock,
      this.timer,
    ))
      ? earliestPacketAtMs
      : null;
  }

  public recordPacketSent(
    earliestPacketAtMs: number,
    durationSamples48Khz: number,
    sentAtMs = this.clock.nowMilliseconds(),
  ): void {
    this.nextPermittedPacketAtMs =
      Math.max(earliestPacketAtMs, sentAtMs) + durationSamples48Khz / 48;
  }
}

async function waitForLivePacketTime(
  whenMs: number,
  signal: AbortSignal,
  clock: LiveRuntimeClock,
  timerPort: LiveRuntimeTimer,
): Promise<boolean> {
  const delayMs = whenMs - clock.nowMilliseconds();
  if (delayMs <= 0 || signal.aborted) {
    return !signal.aborted;
  }
  let timer!: LiveRuntimeTimerHandle;
  const ready = new Promise<boolean>((resolve) => {
    timer = timerPort.schedule(delayMs, () => {
      resolve(true);
    });
  });
  let onAbort!: () => void;
  const aborted = new Promise<boolean>((resolve) => {
    onAbort = () => {
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const readyToSend = await Promise.race([ready, aborted]);
  timerPort.cancel(timer);
  signal.removeEventListener("abort", onAbort);
  return readyToSend && !signal.aborted;
}
