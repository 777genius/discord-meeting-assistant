import {
  MaintainFinalReplies,
  type FinalReplyMaintenancePort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMeetingKnowledgePollingRuntime,
  MeetingKnowledgeDrainTimeoutError,
} from
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
      reconcileUnknown: vi.fn(async () => ({ absentUnconfirmed: 0, containedDuplicates: 1, delivered: 1 })),
    };
    const reportDuplicateContainment = vi.fn();
    const runtime = createMeetingKnowledgePollingRuntime({
      maintenance: new MaintainFinalReplies(jobs, false),
      publication,
      reportDuplicateContainment,
      reportError: vi.fn(),
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(jobs.calls).toEqual([{ maximumJobs: 100, servingEnabled: false }]);
    expect(publication.reconcileUnknown).toHaveBeenCalledOnce();
    expect(publication.reconcileRetractions).toHaveBeenCalledOnce();
    expect(reportDuplicateContainment).toHaveBeenCalledWith(1);

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
      reconcilePending: vi.fn(async () => {}),
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
        reconcileUnknown: async () => ({ absentUnconfirmed: 0, containedDuplicates: 0, delivered: 0 }),
      },
      reportError: vi.fn(),
    });

    runtime.start();
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(["ingress", "maintenance", "process"]);
    expect(handler.start).toHaveBeenCalledOnce();
    expect(handler.reconcilePending).toHaveBeenCalledOnce();
    expect(jobs.calls).toEqual([{ maximumJobs: 100, servingEnabled: true }]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler.reconcilePending).toHaveBeenCalledTimes(2);

    await runtime.close();
    expect(handler.close).toHaveBeenCalledOnce();
    expect(handler.settle).toHaveBeenCalledOnce();
  });

  it("supports deterministic immediate processing and reconciliation passes", async () => {
    const order: string[] = [];
    const runtime = createMeetingKnowledgePollingRuntime({
      maintenance: new MaintainFinalReplies({
        maintain: async () => {
          order.push("maintenance");
          return { cancelled: 0, expired: 0 };
        },
      }, true),
      processor: {
        executeOnce: async () => {
          order.push("process");
          return { status: "idle" as const };
        },
      },
      publication: {
        reconcileRetractions: async () => {
          order.push("retractions");
          return { pending: 0, retracted: 0 };
        },
        reconcileUnknown: async () => {
          order.push("unknown");
          return { absentUnconfirmed: 0, containedDuplicates: 0, delivered: 0 };
        },
      },
      reportError: vi.fn(),
    });

    await runtime.processPending();
    await runtime.reconcilePending();

    expect(order).toEqual(["maintenance", "process", "unknown", "retractions"]);
    await runtime.close();
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

    const closing = expect(runtime.close()).rejects.toBeInstanceOf(
      MeetingKnowledgeDrainTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
  });
});
