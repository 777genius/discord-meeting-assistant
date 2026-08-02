import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

export interface VoicetextPacingScheduler {
  nowMs(): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export const systemVoicetextPacingScheduler: VoicetextPacingScheduler = Object.freeze({
  nowMs: () => performance.now(),
  sleep: async (delayMs: number, signal: AbortSignal) => {
    await delay(delayMs, undefined, { signal });
  },
});
