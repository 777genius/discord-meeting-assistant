import {
  MaintainFinalReplies,
  type FinalReplyMaintenancePort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMeetingKnowledgePollingRuntime } from
  "../src/composition/meeting-knowledge.js";

class MaintenanceFake implements FinalReplyMaintenancePort {
  readonly calls: Parameters<FinalReplyMaintenancePort["maintain"]>[0][] = [];

  public maintain(input: Parameters<FinalReplyMaintenancePort["maintain"]>[0]) {
    this.calls.push(input);
    return Promise.resolve({ cancelled: input.servingEnabled ? 0 : 2, expired: 1 });
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Meeting Knowledge final reply runtime lifecycle", () => {
  it("keeps maintenance and delivery reconciliation active while serving is disabled", async () => {
    vi.useFakeTimers();
    const jobs = new MaintenanceFake();
    const publication = {
      reconcileRetractions: vi.fn(async () => ({ pending: 0, retracted: 1 })),
      reconcileUnknown: vi.fn(async () => ({ absentUnconfirmed: 0, delivered: 1 })),
    };
    const runtime = createMeetingKnowledgePollingRuntime({
      maintenance: new MaintainFinalReplies(jobs, false),
      publication,
      reportError: vi.fn(),
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(jobs.calls).toEqual([{ maximumJobs: 100, servingEnabled: false }]);
    expect(publication.reconcileUnknown).toHaveBeenCalledOnce();
    expect(publication.reconcileRetractions).toHaveBeenCalledOnce();

    await runtime.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(jobs.calls).toHaveLength(1);
    expect(publication.reconcileUnknown).toHaveBeenCalledOnce();
  });

  it("runs serving work only after maintenance without duplicating ingress startup", async () => {
    vi.useFakeTimers();
    const jobs = new MaintenanceFake();
    const order: string[] = [];
    const handler = {
      close: vi.fn(),
      settle: vi.fn(async () => {}),
      start: vi.fn(() => {
        order.push("ingress");
      }),
    };
    const processor = {
      executeOnce: vi.fn(async () => {
        order.push("process");
        return { status: "idle" as const };
      }),
    };
    const maintenance = new MaintainFinalReplies({
      maintain: async (input) => {
        order.push("maintenance");
        return await jobs.maintain(input);
      },
    }, true);
    const runtime = createMeetingKnowledgePollingRuntime({
      handler,
      maintenance,
      processor,
      publication: {
        reconcileRetractions: async () => ({ pending: 0, retracted: 0 }),
        reconcileUnknown: async () => ({ absentUnconfirmed: 0, delivered: 0 }),
      },
      reportError: vi.fn(),
    });

    runtime.start();
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(["ingress", "maintenance", "process"]);
    expect(handler.start).toHaveBeenCalledOnce();
    expect(jobs.calls).toEqual([{ maximumJobs: 100, servingEnabled: true }]);

    await runtime.close();
    expect(handler.close).toHaveBeenCalledOnce();
    expect(handler.settle).toHaveBeenCalledOnce();
  });

  it("bounds shutdown when external reconciliation never settles", async () => {
    vi.useFakeTimers();
    const runtime = createMeetingKnowledgePollingRuntime({
      handler: {
        close: vi.fn(),
        settle: () => new Promise<void>(() => {}),
        start: vi.fn(),
      },
      maintenance: new MaintainFinalReplies(new MaintenanceFake(), false),
      publication: {
        reconcileRetractions: async () => ({ pending: 0, retracted: 0 }),
        reconcileUnknown: () => new Promise(() => {}),
      },
      reportError: vi.fn(),
    });
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    let closed = false;
    const closing = (async () => {
      await runtime.close();
      closed = true;
    })();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(closed).toBe(true);
  });
});
