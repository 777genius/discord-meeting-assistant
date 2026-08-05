const defaultPlaybackTerminalReceiptTimeoutMs = 5_000;

export function resolvePlaybackTerminalReceiptTimeoutMs(
  value?: number,
): number {
  const resolved = value ?? defaultPlaybackTerminalReceiptTimeoutMs;
  if (!Number.isSafeInteger(resolved) || resolved < 100 || resolved > 30_000) {
    throw new RangeError("Craig terminal receipt timeout must be between 100 and 30000ms");
  }
  return resolved;
}

export class PlaybackTerminalDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
  ) {}

  public arm(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onTimeout();
    }, this.timeoutMs);
    this.timer.unref();
  }

  public clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
