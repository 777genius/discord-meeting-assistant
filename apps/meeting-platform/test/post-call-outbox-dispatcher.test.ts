import { describe, expect, it, vi } from "vitest";

import { PostCallOutboxDispatcher } from "../src/post-call-outbox-dispatcher.js";

describe("PostCallOutboxDispatcher", () => {
  it("retains a failed durable item and dispatches it after restart", async () => {
    const pending = [{ meetingId: "meeting-1", schemaVersion: 1 as const }];
    const markPostCallDispatched = vi.fn(async () => {
      pending.splice(0);
    });
    const outbox = {
      listPendingPostCall: async () => [...pending],
      markPostCallDispatched,
    };
    const failedEnqueue = vi.fn(async () => {
      throw new Error("redis unavailable");
    });
    const warn = vi.fn();

    await expect(
      new PostCallOutboxDispatcher(outbox, { enqueue: failedEnqueue }, { warn })
        .dispatchPending(),
    ).resolves.toEqual({ dispatched: 0, failed: 1 });
    expect(pending).toHaveLength(1);
    expect(markPostCallDispatched).not.toHaveBeenCalled();

    const recoveredEnqueue = vi.fn(async () => ({}));
    await expect(
      new PostCallOutboxDispatcher(outbox, { enqueue: recoveredEnqueue }, { warn })
        .dispatchPending(),
    ).resolves.toEqual({ dispatched: 1, failed: 0 });
    expect(recoveredEnqueue).toHaveBeenCalledWith({
      meetingId: "meeting-1",
      schemaVersion: 1,
    });
    expect(markPostCallDispatched).toHaveBeenCalledWith("meeting-1");
  });

  it("coalesces concurrent reconciliation runs", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listPendingPostCall = vi.fn(async () => {
      await gate;
      return [];
    });
    const dispatcher = new PostCallOutboxDispatcher(
      { listPendingPostCall, markPostCallDispatched: async () => {} },
      { enqueue: async () => ({}) },
      { warn: vi.fn() },
    );

    const first = dispatcher.dispatchPending();
    const second = dispatcher.dispatchPending();
    release?.();
    await Promise.all([first, second]);
    expect(listPendingPostCall).toHaveBeenCalledOnce();
  });
});
