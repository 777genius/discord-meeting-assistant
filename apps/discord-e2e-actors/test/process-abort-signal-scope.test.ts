import { describe, expect, it } from "vitest";

import { withProcessAbortSignalScope } from "../src/process-abort-signal-scope.js";

describe("process abort signal scope", () => {
  it.each(["success", "failure"] as const)("removes both signal listeners after %s", async (outcome) => {
    const before = { sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") };
    const operation = withProcessAbortSignalScope("interrupted", async (signal) => {
      expect(signal.aborted).toBe(false);
      expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
      expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);
      if (outcome === "failure") {
        throw new Error("expected failure");
      }
      return "completed";
    });
    if (outcome === "failure") {
      await expect(operation).rejects.toThrow("expected failure");
    } else {
      await expect(operation).resolves.toBe("completed");
    }
    expect(process.listenerCount("SIGINT")).toBe(before.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
  });
});
