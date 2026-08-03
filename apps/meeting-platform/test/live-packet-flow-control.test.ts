import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LiveSessionAdmission,
  SourceTimelinePacer,
  SpeakerPacketFlowControl,
  resolveLivePacketFlowControl,
} from "../src/live-packet-flow-control.js";

describe("live packet flow control", () => {
  afterEach(() => vi.useRealTimers());

  it("allows the explicit ten-session production ceiling and rejects a larger value", () => {
    expect(
      resolveLivePacketFlowControl({ maximumConcurrentSessions: 10 }),
    ).toMatchObject({ maximumConcurrentSessions: 10 });
    expect(() =>
      resolveLivePacketFlowControl({ maximumConcurrentSessions: 11 }),
    ).toThrow(RangeError);
  });

  it("admits provider sessions in FIFO order", async () => {
    const admission = new LiveSessionAdmission(1);
    const first = await admission.acquire(new AbortController().signal);
    if (first === null) {
      throw new Error("first live session was not admitted");
    }
    const order: string[] = [];
    const secondPromise = admission.acquire(new AbortController().signal).then((release) => {
      if (release === null) {
        throw new Error("second live session was not admitted");
      }
      order.push("second");
      return release;
    });
    const thirdPromise = admission.acquire(new AbortController().signal).then((release) => {
      if (release === null) {
        throw new Error("third live session was not admitted");
      }
      order.push("third");
      return release;
    });

    first();
    const second = await secondPromise;
    expect(order).toEqual(["second"]);
    second();
    const third = await thirdPromise;
    expect(order).toEqual(["second", "third"]);
    third();
  });

  it("bounds a speaker queue and wakes a post-durability waiter when capacity returns", async () => {
    vi.useFakeTimers();
    const flow = new SpeakerPacketFlowControl(1);
    flow.reserveQueueSlot();

    const waiting = flow.waitForQueueSlot(Date.now() + 100, () => false);
    await Promise.resolve();
    flow.releaseQueueSlot();

    await expect(waiting).resolves.toBe(true);
    expect(flow.queuedPacketCount).toBe(0);
  });

  it("paces consecutive packets at their source duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const pacer = new SourceTimelinePacer();
    const signal = new AbortController().signal;

    const firstAtMs = await pacer.waitForPacketTime(1_000, 0, signal);
    expect(firstAtMs).toBe(750);
    pacer.recordPacketSent(firstAtMs!, 960);

    const second = pacer.waitForPacketTime(1_000, 20, signal);
    await vi.advanceTimersByTimeAsync(19);
    await expect(Promise.race([second, Promise.resolve(null)])).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toBe(1_020);
  });
});
