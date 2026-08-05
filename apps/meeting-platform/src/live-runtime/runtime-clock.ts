import type {
  LiveRuntimeClock,
  LiveRuntimeTimer,
  LiveRuntimeTimerHandle,
} from "./contracts.js";

function unref(handle: LiveRuntimeTimerHandle): LiveRuntimeTimerHandle {
  handle.unref?.();
  return handle;
}

export const systemLiveRuntimeClock: LiveRuntimeClock = Object.freeze({
  monotonicMilliseconds: () => performance.now(),
  nowMilliseconds: () => Date.now(),
});

export const systemLiveRuntimeTimer: LiveRuntimeTimer = Object.freeze({
  cancel: (handle: LiveRuntimeTimerHandle): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  repeat: (
    intervalMs: number,
    callback: () => void,
  ): LiveRuntimeTimerHandle => unref(setInterval(callback, intervalMs)),
  schedule: (
    delayMs: number,
    callback: () => void,
  ): LiveRuntimeTimerHandle => unref(setTimeout(callback, delayMs)),
});
