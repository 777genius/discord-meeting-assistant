import type { Server } from "node:http";

import type { S3Client } from "@aws-sdk/client-s3";
import type { PostCallWorker } from "@discord-meeting/bullmq-adapter";
import type { Logger } from "@discord-meeting/observability-adapter";
import type { Client } from "discord.js";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { PlatformLiveMeetingRuntime } from "../src/live-meeting-runtime.js";
import {
  closeMeetingPlatformResources,
} from "../src/platform-runtime.js";
import type { GrpcSubscriptionRuntimeTransport } from "../src/subscription-runtime-grpc-transport.js";

describe("meeting platform shutdown wiring", () => {
  it("starts BullMQ admission closure before slow HTTP and live drains", async () => {
    const calls: string[] = [];
    let resumePause!: () => void;
    const pause = new Promise<void>((resolve) => {
      resumePause = resolve;
    });
    const worker = {
      cancelActivePostCallJobs: () => {
        calls.push("worker:cancel");
      },
      close: async (force?: boolean) => {
        calls.push(`worker:close:${String(force)}`);
      },
      pause: () => {
        calls.push("worker:pause");
        return pause;
      },
      waitForActivePostCallJobs: async () => {
        calls.push("worker:wait");
      },
    } as unknown as PostCallWorker;
    const server = {
      close: (callback: (error?: Error) => void) => {
        calls.push("server:close");
        callback();
      },
      listening: true,
    } as unknown as Server;
    const live = {
      close: async () => {
        calls.push("live:close");
      },
    } as unknown as PlatformLiveMeetingRuntime;
    const logger = {
      flush: async () => {
        calls.push("logger:flush");
      },
    } as unknown as Logger;

    const closing = closeMeetingPlatformResources({
      deadLetterQueue: {
        close: async () => {
          calls.push("dead-letter:close");
        },
      },
      discord: {
        destroy: () => {
          calls.push("discord:destroy");
        },
      } as unknown as Client,
      live,
      logger,
      pool: {
        end: async () => {
          calls.push("pool:end");
        },
      } as unknown as Pool,
      queue: {
        close: async () => {
          calls.push("queue:close");
        },
      },
      queueEvents: {
        close: async () => {
          calls.push("events:close");
        },
      },
      runtimeTransport: {
        close: () => {
          calls.push("runtime:close");
        },
      } as unknown as GrpcSubscriptionRuntimeTransport,
      s3: {
        destroy: () => {
          calls.push("s3:destroy");
        },
      } as unknown as S3Client,
      server,
      worker,
    });

    expect(calls).toEqual([
      "worker:pause",
      "worker:cancel",
      "server:close",
      "live:close",
    ]);
    resumePause();
    await closing;

    expect(calls.indexOf("worker:cancel")).toBeLessThan(
      calls.indexOf("server:close"),
    );
    expect(calls.indexOf("worker:cancel")).toBeLessThan(
      calls.indexOf("live:close"),
    );
    expect(calls.indexOf("worker:close:true")).toBeLessThan(
      calls.indexOf("queue:close"),
    );
  });
});
