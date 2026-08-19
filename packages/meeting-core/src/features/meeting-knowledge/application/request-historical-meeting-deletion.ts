import type { HistoricalSyncStore } from "./ports/historical-state.js";

/**
 * Purpose-specific source-withdrawal edge. An authorized source adapter owns
 * admission; this use case only turns the already-authorized local meeting
 * identity into durable cleanup intent. Serving and indexing flags are not
 * inputs and therefore cannot suppress deletion.
 */
export class RequestHistoricalMeetingDeletion {
  public constructor(
    private readonly store: Pick<HistoricalSyncStore, "requestMeetingDeletion">,
  ) {}

  public async execute(meetingId: string): Promise<void> {
    const normalized = meetingId.trim();
    if (
      normalized.length === 0 ||
      new TextEncoder().encode(normalized).byteLength > 1_000
    ) {
      throw new RangeError("historical deletion meeting identity is invalid");
    }
    await this.store.requestMeetingDeletion(normalized);
  }
}
