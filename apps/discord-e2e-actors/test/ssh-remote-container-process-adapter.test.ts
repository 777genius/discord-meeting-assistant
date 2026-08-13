import { describe, expect, it, vi } from "vitest";

import type { BoundedRemoteContainerProcessResult } from "../src/hosted-remote-discord-identity-probe.js";
import {
  SshRemoteContainerProcessAdapter,
  type BoundedRemoteCommandPort,
} from "../src/ssh-remote-container-process-adapter.js";

const containerId = "1".repeat(64);
const imageDigestSha256 = "2".repeat(64);
const imageId = `sha256:${"3".repeat(64)}`;
const sourceRevision = "4".repeat(40);
const binding = { containerId, host: "test-host", imageDigestSha256, sourceRevision } as const;
const request = {
  args: ["/app/apps/meeting-platform/node_modules/.bin/tsx", "/app/apps/meeting-platform/src/run-hosted-discord-identity-probe.ts", "--json"],
  binding,
  maximumOutputBytes: 16_384,
  timeoutMs: 10_000,
} as const;

describe("SSH remote container process adapter", () => {
  it("proves exact running test-only provenance before fixed-argv docker exec", async () => {
    const execute = vi.fn<BoundedRemoteCommandPort["execute"]>()
      .mockResolvedValueOnce(ok(containerJson()))
      .mockResolvedValueOnce(ok(imageJson()))
      .mockResolvedValueOnce({ exitCode: 7, signal: null, stderr: "failed", stdout: "out", timedOut: false });

    const result = await new SshRemoteContainerProcessAdapter({ execute }, () => 1_000).execute(request);

    expect(result).toEqual({ exitCode: 7, signal: null, stderr: "failed", stdout: "out", timedOut: false });
    expect(execute.mock.calls.map(([call]) => call.args)).toEqual([
      ["docker", "inspect", "--format", expect.stringContaining("e2e.test-only"), containerId],
      ["docker", "image", "inspect", "--format", expect.stringContaining("RepoDigests"), imageId],
      [
        "docker", "exec", "-i", "-w", "/app/apps/meeting-platform", containerId,
        ...request.args,
      ],
    ]);
    expect(execute.mock.calls.every(([call]) => call.host === binding.host)).toBe(true);
    expect(execute.mock.calls.flatMap(([call]) => call.args)).not.toContain("sh");
    expect(execute.mock.calls.flatMap(([call]) => call.args)).not.toContain("-c");
  });

  it.each<[
    string,
    { container?: Record<string, unknown>; image?: Record<string, unknown> },
  ]>([
    ["different container", { container: { containerId: "5".repeat(64) } }],
    ["not running", { container: { running: false } }],
    ["not test-only", { container: { testOnly: "false" } }],
    ["wrong Compose project", { container: { composeProject: "production" } }],
    ["wrong Compose service", { container: { composeService: "worker" } }],
    ["different image ID", { image: { imageId: `sha256:${"6".repeat(64)}` } }],
    ["different repository digest", { image: { repositoryDigests: [`registry.test/platform@sha256:${"7".repeat(64)}`] } }],
    ["different source revision", { image: { sourceRevision: "8".repeat(40) } }],
  ])("fails closed for %s without executing in the container", async (_label, overrides) => {
    const execute = vi.fn<BoundedRemoteCommandPort["execute"]>()
      .mockResolvedValueOnce(ok(containerJson(overrides.container)))
      .mockResolvedValueOnce(ok(imageJson(overrides.image)));

    await expect(new SshRemoteContainerProcessAdapter({ execute }, () => 1_000).execute(request))
      .rejects.toThrow();
    expect(execute.mock.calls.some(([call]) => call.args[1] === "exec")).toBe(false);
  });

  it("shares the caller's timeout and output budgets across inspection and execution", async () => {
    const times = [1_000, 1_000, 1_100, 1_300];
    const execute = vi.fn<BoundedRemoteCommandPort["execute"]>()
      .mockResolvedValueOnce(ok(containerJson()))
      .mockResolvedValueOnce(ok(imageJson()))
      .mockResolvedValueOnce(ok("done\n"));

    await new SshRemoteContainerProcessAdapter({ execute }, () => times.shift() ?? 1_300)
      .execute({ ...request, maximumOutputBytes: 2_000, timeoutMs: 1_000 });

    const calls = execute.mock.calls.map(([call]) => call);
    expect(calls.map((call) => call.timeoutMs)).toEqual([1_000, 900, 700]);
    expect(calls[1]?.maximumOutputBytes).toBeLessThan(2_000);
    expect(calls[2]?.maximumOutputBytes).toBeLessThan(calls[1]?.maximumOutputBytes ?? 0);
  });

  it("forwards cancellation to every remote command", async () => {
    const signal = new AbortController().signal;
    const execute = vi.fn<BoundedRemoteCommandPort["execute"]>()
      .mockResolvedValueOnce(ok(containerJson()))
      .mockResolvedValueOnce(ok(imageJson()))
      .mockResolvedValueOnce(ok("done\n"));
    await new SshRemoteContainerProcessAdapter({ execute }, () => 1_000).execute({ ...request, signal });
    expect(execute.mock.calls.every(([call]) => call.signal === signal)).toBe(true);
  });

  it.each([
    ["inspection timeout", { timedOut: true }],
    ["inspection stderr", { stderr: "warning" }],
    ["inspection non-zero", { exitCode: 1 }],
    ["inspection signal", { signal: "SIGTERM" as const }],
  ])("rejects %s before any docker exec", async (_label, override) => {
    const execute = vi.fn<BoundedRemoteCommandPort["execute"]>()
      .mockResolvedValueOnce({ ...ok(containerJson()), ...override });
    await expect(new SshRemoteContainerProcessAdapter({ execute }).execute(request)).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

function containerJson(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    composeProject: "discord-meeting-assistant",
    composeService: "meeting-platform",
    containerId,
    imageId,
    running: true,
    testOnly: "true",
    ...overrides,
  })}\n`;
}

function imageJson(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    imageId,
    repositoryDigests: [`registry.test/platform@sha256:${imageDigestSha256}`],
    sourceRevision,
    ...overrides,
  })}\n`;
}

function ok(stdout: string): BoundedRemoteContainerProcessResult {
  return { exitCode: 0, signal: null, stderr: "", stdout, timedOut: false };
}
