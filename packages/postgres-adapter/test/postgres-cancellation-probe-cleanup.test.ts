import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { finishPostgresCancellationProbe } from "./postgres-integration-fixtures.js";

// Use the real pg pool lifecycle, with an in-memory transport whose physical
// close is held until the test explicitly completes it. No server or timer is
// needed to put a destroyed client in the release-to-socket-close window.
class ClosingProbeClient extends Client {
  readonly closes: (() => void)[] = [];

  public override connect(): Promise<Client>;
  public override connect(
    callback: ((error: Error) => void) | ((error: null, client: Client) => void),
  ): void;
  public override connect(
    callback?: ((error: Error) => void) | ((error: null, client: Client) => void),
  ): Promise<Client> | void {
    if (callback !== undefined) {
      Reflect.apply(callback, undefined, [null, this]);
      return;
    }
    return Promise.resolve(this);
  }

  public override end(): Promise<void>;
  public override end(callback: (error: Error) => void): void;
  public override end(callback?: (error: Error) => void): Promise<void> | void {
    if (callback !== undefined) {
      this.closes.push(() => { Reflect.apply(callback, undefined, []); });
      return;
    }
    return new Promise<void>((resolve) => {
      this.closes.push(resolve);
    });
  }

  public finishClose(): void {
    for (const close of this.closes.splice(0)) {
      close();
    }
    this.emit("end");
  }
}

describe("PostgreSQL cancellation probe cleanup", () => {
  it("reproduces the old late 57P01 through the real pool after destroy release", async () => {
    const pool = new Pool({ Client: ClosingProbeClient });
    const client = await pool.connect();
    const transport = client as unknown as ClosingProbeClient;
    const terminated = Object.assign(
      new Error("terminating connection due to administrator command"),
      { code: "57P01" },
    );
    try {
      client.release(true);
      expect(pool.totalCount).toBe(0);
      // The old finally issued pg_terminate_backend after this release. Deliver
      // its server error before physical close: pg still forwards it to pool.
      expect(() => client.emit("error", terminated)).toThrow(terminated);
    } finally {
      transport.finishClose();
      await pool.end();
    }
  });

  it("aborts and drains outstanding work before returning, without terminating its released client", async () => {
    const pool = new Pool({ Client: ClosingProbeClient });
    const client = await pool.connect();
    const transport = client as unknown as ClosingProbeClient;
    const controller = new AbortController();
    let completeCancellation!: () => void;
    const operation = new Promise<void>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        completeCancellation = () => {
          client.release(true);
          reject(controller.signal.reason);
        };
      }, { once: true });
    });
    let cleaned = false;
    try {
      const cleanup = finishPostgresCancellationProbe(controller, operation).then(() => {
        cleaned = true;
        return;
      });
      expect(controller.signal.aborted).toBe(true);
      await Promise.resolve();
      expect(cleaned).toBe(false);
      expect(pool.totalCount).toBe(1);
      completeCancellation();
      await cleanup;
      expect(cleaned).toBe(true);
      expect(pool.totalCount).toBe(0);
      expect(transport.closes).toHaveLength(1);
      // No error listener is installed to suppress unexpected pool failures.
      expect(pool.listenerCount("error")).toBe(0);
    } finally {
      transport.finishClose();
      await pool.end();
    }
  });

  it("preserves the original abort reason and surfaces unexpected cleanup failures", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic cancellation");
    controller.abort(reason);
    await expect(finishPostgresCancellationProbe(controller, Promise.reject(reason)))
      .resolves.toBeUndefined();
    expect(controller.signal.reason).toBe(reason);
    const failure = new Error("backend cancellation could not be verified");
    await expect(finishPostgresCancellationProbe(controller, Promise.reject(failure)))
      .rejects.toBe(failure);
  });
});
