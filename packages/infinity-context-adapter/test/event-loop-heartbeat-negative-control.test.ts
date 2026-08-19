import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

describe("event-loop heartbeat test control", () => {
  it("detects an intentional main-thread block longer than 100 ms", async () => {
    const delaysMs: number[] = [];
    let prior = performance.now();
    let observeHeartbeat: (() => void) | undefined;
    const nextHeartbeat = (): Promise<void> => new Promise((resolve) => {
      observeHeartbeat = resolve;
    });
    const heartbeat = setInterval(() => {
      const current = performance.now();
      delaysMs.push(current - prior);
      prior = current;
      observeHeartbeat?.();
      observeHeartbeat = undefined;
    }, 5);

    try {
      await nextHeartbeat();
      const heartbeatAfterBlock = nextHeartbeat();
      const blockUntil = performance.now() + 150;
      let work = 0;
      while (performance.now() < blockUntil) {
        work = (work + 1) % 1_000;
      }
      await heartbeatAfterBlock;

      expect(work).toBeGreaterThanOrEqual(0);
      expect(delaysMs.length).toBeGreaterThan(1);
      expect(Math.max(...delaysMs)).toBeGreaterThan(100);
    } finally {
      clearInterval(heartbeat);
    }
  });
});
