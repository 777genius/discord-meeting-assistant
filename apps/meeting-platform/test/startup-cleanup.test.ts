import { describe, expect, it } from "vitest";

import {
  PlatformStartupCleanup,
  rethrowAfterFailedPlatformStartup,
} from "../src/composition/startup-cleanup.js";

describe("PlatformStartupCleanup", () => {
  it("closes every started resource when one cleanup operation fails", async () => {
    const cleanup = new PlatformStartupCleanup();
    const closed: string[] = [];
    cleanup.defer("database", () => {
      closed.push("database");
    });
    cleanup.defer("runtime", () => {
      closed.push("runtime");
      throw new Error("runtime close failed");
    });
    cleanup.defer("HTTP host", () => {
      closed.push("HTTP host");
    });

    await expect(cleanup.close()).rejects.toBeInstanceOf(AggregateError);
    expect(closed).toEqual(["HTTP host", "runtime", "database"]);
  });

  it("runs the registered cleanup only once", async () => {
    const cleanup = new PlatformStartupCleanup();
    let closed = 0;
    cleanup.defer("resource", () => {
      closed += 1;
    });

    await Promise.all([cleanup.close(), cleanup.close()]);

    expect(closed).toBe(1);
  });

  it("waits for each reverse cleanup before starting its dependency", async () => {
    const cleanup = new PlatformStartupCleanup();
    const closed: string[] = [];
    let releaseHttp!: () => void;
    let signalHttpStarted!: () => void;
    const httpStarted = new Promise<void>((resolve) => {
      signalHttpStarted = resolve;
    });
    const httpClose = new Promise<void>((resolve) => {
      releaseHttp = resolve;
    });
    cleanup.defer("database", () => {
      closed.push("database");
    });
    cleanup.defer("runtime", () => {
      closed.push("runtime");
    });
    cleanup.defer("HTTP host", async () => {
      closed.push("HTTP host");
      signalHttpStarted();
      await httpClose;
    });

    const closing = cleanup.close();
    await httpStarted;
    expect(closed).toEqual(["HTTP host"]);

    releaseHttp();
    await closing;
    expect(closed).toEqual(["HTTP host", "runtime", "database"]);
  });

  it("retains the startup failure when reverse cleanup also fails", async () => {
    const cleanup = new PlatformStartupCleanup();
    const startupFailure = new Error("startup failed");
    const cleanupCause = new Error("resource close failed");
    cleanup.defer("resource", () => {
      throw cleanupCause;
    });

    let failure: unknown;
    try {
      await rethrowAfterFailedPlatformStartup(startupFailure, cleanup);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toBe(startupFailure);
    expect(aggregate.errors[1]).toBeInstanceOf(AggregateError);
    const cleanupFailure = aggregate.errors[1] as AggregateError;
    expect(cleanupFailure.errors[0]).toMatchObject({ cause: cleanupCause });
  });
});
