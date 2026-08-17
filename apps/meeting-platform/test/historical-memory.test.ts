import type { Logger } from "@discord-meeting/observability-adapter";
import { describe, expect, it, vi } from "vitest";

import { createHistoricalReconciliationLifecycle } from
  "../src/composition/historical-memory.js";

function createLogger(warn = vi.fn()): Logger {
  return { warn } as unknown as Logger;
}

describe("historical memory reconciliation lifecycle", () => {
  it("returns from start while the initial backlog pass is still active", async () => {
    let settlePass!: () => void;
    const executePass = vi.fn(() => new Promise<void>((resolve) => {
      settlePass = resolve;
    }));
    const lifecycle = createHistoricalReconciliationLifecycle({
      executePass,
      logger: createLogger(),
    });

    await lifecycle.start();

    expect(executePass).toHaveBeenCalledOnce();
    settlePass();
    await lifecycle.close();
  });

  it("aborts and drains the active pass when closed", async () => {
    let passSignal: AbortSignal | undefined;
    const warn = vi.fn();
    const lifecycle = createHistoricalReconciliationLifecycle({
      executePass: (signal) => {
        passSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      logger: createLogger(warn),
    });

    await lifecycle.start();
    await lifecycle.close();

    expect(passSignal?.aborted).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("observes a pass rejection and remains restart-safe", async () => {
    const warn = vi.fn();
    const lifecycle = createHistoricalReconciliationLifecycle({
      executePass: () => {
        throw new TypeError("Infinity unavailable");
      },
      logger: createLogger(warn),
    });

    await lifecycle.start();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        "Historical memory reconciliation failed",
        { errorType: "TypeError" },
      );
    });
    await expect(lifecycle.start()).resolves.toBeUndefined();
    await lifecycle.close();
  });
});
