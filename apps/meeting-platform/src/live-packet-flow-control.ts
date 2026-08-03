const defaultMaximumQueuedPacketsPerSpeaker = 512;
const maximumQueuedPacketsPerSpeaker = 512;
const defaultMaximumConcurrentLiveSessions = 3;
const maximumConcurrentLiveSessions = 10;
const defaultPacketBackpressureTimeoutMs = 2_000;
const minimumPacketBackpressureTimeoutMs = 100;
const maximumPacketBackpressureTimeoutMs = 30_000;
// Let Craig's source clock lead the wall clock slightly for normal network
// jitter, but never burst arbitrary backlogs into the provider.
const maximumLivePacketLeadMs = 250;

export interface LivePacketFlowControl {
  /** Validated to a deliberate platform safety ceiling of ten live sessions. */
  readonly maximumConcurrentSessions?: number;
  /** Kept injectable for deterministic regression tests; production max is 512. */
  readonly maximumQueuedPacketsPerSpeaker?: number;
  /** Maximum time a post-durability request may wait for derived queue capacity. */
  readonly packetBackpressureTimeoutMs?: number;
}

export interface ResolvedLivePacketFlowControl {
  readonly maximumConcurrentSessions: number;
  readonly maximumQueuedPacketsPerSpeaker: number;
  readonly packetBackpressureTimeoutMs: number;
}

export type LiveSessionRelease = () => void;

interface PacketCapacityWaiter {
  wake(): void;
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
    maximumQueuedPacketsPerSpeaker: maximumQueuedPackets,
    packetBackpressureTimeoutMs,
  };
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

  public constructor(public readonly maximumQueuedPackets: number) {
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
    const remainingMs = deadlineMs - Date.now();
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
    let timeout!: NodeJS.Timeout;
    const timeoutElapsed = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => {
        resolve(false);
      }, remainingMs);
      timeout.unref();
    });
    if (isClosed()) {
      waiter.wake();
    }
    const available = await Promise.race([capacityAvailable, timeoutElapsed]);
    clearTimeout(timeout);
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

/** Paces one speaker's Opus stream against Craig's source timeline. */
export class SourceTimelinePacer {
  private nextPermittedPacketAtMs = 0;

  public async waitForPacketTime(
    meetingStartedAtMs: number,
    relativeTimeMs: number,
    signal: AbortSignal,
  ): Promise<number | null> {
    const earliestPacketAtMs = Math.max(
      meetingStartedAtMs + relativeTimeMs - maximumLivePacketLeadMs,
      this.nextPermittedPacketAtMs,
    );
    return (await waitForLivePacketTime(earliestPacketAtMs, signal))
      ? earliestPacketAtMs
      : null;
  }

  public recordPacketSent(
    earliestPacketAtMs: number,
    durationSamples48Khz: number,
    sentAtMs = Date.now(),
  ): void {
    this.nextPermittedPacketAtMs =
      Math.max(earliestPacketAtMs, sentAtMs) + durationSamples48Khz / 48;
  }
}

async function waitForLivePacketTime(
  whenMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const delayMs = whenMs - Date.now();
  if (delayMs <= 0 || signal.aborted) {
    return !signal.aborted;
  }
  let timer!: NodeJS.Timeout;
  const ready = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(true);
    }, delayMs);
    timer.unref();
  });
  let onAbort!: () => void;
  const aborted = new Promise<boolean>((resolve) => {
    onAbort = () => {
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const readyToSend = await Promise.race([ready, aborted]);
  clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);
  return readyToSend && !signal.aborted;
}
