const defaultMaximumPendingTerminalIntents = 10_000;
const defaultTerminalIntentTtlMs = 24 * 60 * 60 * 1_000;

interface TerminalEndTimeIntent {
  readonly completed: boolean;
  readonly endedAtMs: number;
  readonly expiresAtMs: number;
}

/** Bounded bridge for a terminal lifecycle event that arrives before start. */
export class TerminalEndTimeIntents {
  private readonly entries = new Map<string, TerminalEndTimeIntent>();

  public constructor(
    private readonly maximumEntries = defaultMaximumPendingTerminalIntents,
    private readonly ttlMs = defaultTerminalIntentTtlMs,
  ) {}

  public remember(
    recordingId: string,
    endedAtMs: number,
    observedAtMs: number,
  ): number {
    this.prune(observedAtMs);
    const existing = this.entries.get(recordingId);
    if (existing !== undefined) {
      return existing.endedAtMs;
    }
    while (this.entries.size >= this.maximumEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
    this.entries.set(recordingId, {
      completed: false,
      endedAtMs,
      expiresAtMs: observedAtMs + this.ttlMs,
    });
    return endedAtMs;
  }

  public get(recordingId: string, nowMs: number): number | undefined {
    this.prune(nowMs);
    return this.entries.get(recordingId)?.endedAtMs;
  }

  public complete(recordingId: string): void {
    const existing = this.entries.get(recordingId);
    if (existing !== undefined) {
      this.entries.set(recordingId, { ...existing, completed: true });
    }
  }

  public recordingIds(nowMs: number): readonly string[] {
    this.prune(nowMs);
    return [...this.entries]
      .filter(([, intent]) => !intent.completed)
      .map(([recordingId]) => recordingId);
  }

  private prune(nowMs: number): void {
    for (const [recordingId, intent] of this.entries) {
      if (intent.expiresAtMs > nowMs) {
        break;
      }
      this.entries.delete(recordingId);
    }
  }
}
