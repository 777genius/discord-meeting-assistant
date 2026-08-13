import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { runBoundedSshCommand } from "../src/ssh-remote-container-process-adapter.js";

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
});

describe("bounded SSH remote command hard stop", () => {
  it("rejects within a finite bound when a killed child never closes", async () => {
    vi.useFakeTimers();
    const kill = vi.fn(() => true);
    spawnMock.mockReturnValue(fakeChildProcess(kill));
    const execution = runBoundedSshCommand({
      args: ["true"],
      host: "test-host",
      maximumOutputBytes: 1_024,
      timeoutMs: 100,
    });
    const rejection = expect(execution).rejects.toThrow("did not exit after SIGKILL");

    await vi.advanceTimersByTimeAsync(6_100);

    await rejection;
    expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("clears the hard-stop path when the child closes after SIGKILL", async () => {
    vi.useFakeTimers();
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const execution = runBoundedSshCommand({
      args: ["true"], host: "test-host", maximumOutputBytes: 1_024, timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1_100);
    child.emit("close", null, "SIGKILL");
    await expect(execution).resolves.toMatchObject({ signal: "SIGKILL", timedOut: true });
    await vi.advanceTimersByTimeAsync(5_000);
  });
});

function fakeChildProcess(kill: ChildProcess["kill"] = vi.fn(() => true)): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.kill = kill;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}
