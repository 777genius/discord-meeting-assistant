import { EventEmitter } from "node:events";

import type { DiscordGuildSetupCommandHandler } from "@discord-meeting/discord-adapter";
import type { Client } from "discord.js";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlatformConfig } from "../src/config.js";

const discordAdapter = vi.hoisted(() => ({
  registerDiscordGuildSetupCommand: vi.fn(),
}));

vi.mock("@discord-meeting/discord-adapter", () => ({
  registerDiscordGuildSetupCommand:
    discordAdapter.registerDiscordGuildSetupCommand,
}));

import { startPlatformServices } from "../src/composition/startup.js";

type PlatformStartupInput = Parameters<typeof startPlatformServices>[0];

afterEach(() => {
  vi.clearAllMocks();
});

function createInput(calls: string[]): PlatformStartupInput {
  return {
    config: {
      discordApplicationId: "meeting-platform-app",
      port: 8_080,
      secrets: { discordToken: "test-token" },
    } as PlatformConfig,
    dependencyReadiness: {
      assertReady: async () => {
        calls.push("dependencies:ready");
      },
    },
    discord: Object.assign(new EventEmitter(), {
      application: { id: "meeting-platform-app" },
      isReady: () => true,
      login: async () => {
        calls.push("discord:login");
      },
    }) as unknown as Client,
    guildSetupHandler: {
      start: () => {
        calls.push("guild-setup:start");
      },
    } as unknown as DiscordGuildSetupCommandHandler,
    logger: {
      error: () => {
        calls.push("logger:error");
      },
      info: () => {
        calls.push("logger:info");
      },
    },
    meetingPlatformInstallUrl: "https://discord.example/install",
    outboxDispatcher: {
      dispatchPending: async () => {
        calls.push("outbox:dispatch");
      },
    },
    pool: {
      query: async () => {
        calls.push("database:ping");
      },
    } as unknown as Pool,
    recordings: {
      acquireExclusiveSpoolOwnership: async () => {
        calls.push("recordings:ownership");
      },
    },
    queue: {
      waitUntilReady: async () => {
        calls.push("queue:ready");
      },
    },
    queueEvents: {
      waitUntilReady: async () => {
        calls.push("queue-events:ready");
      },
    },
    schemaReadiness: {
      assertReady: async () => {
        calls.push("schema:ready");
      },
    },
    server: {
      close: async () => {},
      start: async () => {
        calls.push("http:start");
      },
    },
    worker: {
      run: () => {
        calls.push("worker:run");
        return new Promise<void>(() => {});
      },
      waitUntilReady: async () => {
        calls.push("worker:ready");
      },
    },
  };
}

describe("startPlatformServices", () => {
  it("opens worker admission only after ownership and all required readiness checks", async () => {
    const calls: string[] = [];
    discordAdapter.registerDiscordGuildSetupCommand.mockImplementation(async () => {
      calls.push("discord:register-command");
    });

    await startPlatformServices(createInput(calls));

    expect(calls).toEqual([
      "recordings:ownership",
      "database:ping",
      "schema:ready",
      "queue:ready",
      "queue-events:ready",
      "discord:login",
      "discord:register-command",
      "dependencies:ready",
      "guild-setup:start",
      "worker:ready",
      "worker:run",
      "outbox:dispatch",
      "http:start",
      "logger:info",
    ]);
  });

  it("does not activate the worker when a mandatory dependency is unhealthy", async () => {
    const calls: string[] = [];
    const input = {
      ...createInput(calls),
      dependencyReadiness: {
        assertReady: async () => {
          calls.push("dependencies:ready");
          throw new Error("object storage is unavailable");
        },
      },
    };

    await expect(startPlatformServices(input)).rejects.toThrow(
      "object storage is unavailable",
    );
    expect(calls).toContain("discord:login");
    expect(calls).not.toContain("worker:run");
    expect(calls).not.toContain("outbox:dispatch");
    expect(calls).not.toContain("http:start");
  });

  it("does not activate the worker, outbox, or HTTP when schema readiness fails", async () => {
    const calls: string[] = [];
    const input = {
      ...createInput(calls),
      schemaReadiness: {
        assertReady: async () => {
          calls.push("schema:ready");
          throw new Error("schema is stale");
        },
      },
    };

    await expect(startPlatformServices(input)).rejects.toThrow("schema is stale");
    expect(calls).toEqual(expect.arrayContaining([
      "recordings:ownership",
      "database:ping",
      "schema:ready",
    ]));
    expect(calls).not.toContain("worker:run");
    expect(calls).not.toContain("outbox:dispatch");
    expect(calls).not.toContain("http:start");
  });

  it("fails startup before outbox and HTTP if worker activation rejects immediately", async () => {
    const calls: string[] = [];
    const input = {
      ...createInput(calls),
      worker: {
        run: () => {
          calls.push("worker:run");
          return Promise.reject(new Error("worker start failed"));
        },
        waitUntilReady: async () => {
          calls.push("worker:ready");
        },
      },
    };

    await expect(startPlatformServices(input)).rejects.toThrow(
      "Post-call worker failed during startup",
    );
    expect(calls).toContain("logger:error");
    expect(calls).not.toContain("outbox:dispatch");
    expect(calls).not.toContain("http:start");
  });

  it("starts HTTP without waiting for the derived historical backlog", async () => {
    const calls: string[] = [];
    const input = {
      ...createInput(calls),
      historicalMemory: {
        assertReady: async () => {
          calls.push("historical:ready");
        },
        start: () => {
          calls.push("historical:start");
          return new Promise<void>(() => {});
        },
      },
    };

    await startPlatformServices(input);

    expect(calls).toContain("historical:ready");
    expect(calls).toContain("historical:start");
    expect(calls.indexOf("http:start")).toBeLessThan(
      calls.indexOf("historical:start"),
    );
  });

  it("observes a detached historical-memory startup rejection", async () => {
    const calls: string[] = [];
    const error = vi.fn();
    const input = {
      ...createInput(calls),
      historicalMemory: {
        assertReady: async () => {},
        start: async () => {
          throw new Error("historical runtime failed");
        },
      },
      logger: {
        error,
        info: vi.fn(),
      },
    };

    await startPlatformServices(input);
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith("Historical memory runtime failed", {
        errorType: "Error",
      });
    });
  });
});
