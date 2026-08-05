import { afterEach, describe, expect, it, vi } from "vitest";

import { SystemConversationDelay } from "../src/adapters/outbound/system-conversation-delay.js";

describe("SystemConversationDelay", () => {
  afterEach(() => vi.useRealTimers());

  it("settles exactly once when cancellation races the timer", async () => {
    vi.useFakeTimers();
    const delay = new SystemConversationDelay();

    const cancelledFirst = delay.start(1_300);
    cancelledFirst.cancel();
    await vi.advanceTimersByTimeAsync(1_300);
    cancelledFirst.cancel();
    await expect(cancelledFirst.elapsed).resolves.toBe("cancelled");

    const elapsedFirst = delay.start(1_300);
    await vi.advanceTimersByTimeAsync(1_300);
    elapsedFirst.cancel();
    await expect(elapsedFirst.elapsed).resolves.toBe("elapsed");
  });
});
