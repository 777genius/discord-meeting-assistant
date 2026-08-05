import { describe, expect, it, vi } from "vitest";

import { startPreparedSidecar } from "../src/sidecar-startup.js";

describe("startPreparedSidecar", () => {
  it("disposes a prewarmed app-server when gRPC startup fails", async () => {
    const disposePreparedRuntime = vi.fn(async () => {});
    const prepareRuntime = vi.fn(async () => {});
    const startupFailure = new Error("gRPC bind failed");

    await expect(
      startPreparedSidecar({
        disposePreparedRuntime,
        prepareRuntime,
        startServer: async () => {
          throw startupFailure;
        },
      }),
    ).rejects.toBe(startupFailure);

    expect(prepareRuntime).toHaveBeenCalledOnce();
    expect(disposePreparedRuntime).toHaveBeenCalledOnce();
  });

  it("does not dispose a runtime after successful server startup", async () => {
    const disposePreparedRuntime = vi.fn(async () => {});
    const server = { serving: true } as const;

    await expect(
      startPreparedSidecar({
        disposePreparedRuntime,
        prepareRuntime: async () => {},
        startServer: async () => server,
      }),
    ).resolves.toBe(server);
    expect(disposePreparedRuntime).not.toHaveBeenCalled();
  });
});
