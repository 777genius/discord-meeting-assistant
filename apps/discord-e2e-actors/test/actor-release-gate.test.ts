import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  connectActorsAfterReleaseGate,
  waitForActorGateArmed,
  waitForActorReleaseGate,
} from "../src/actor-release-gate.js";
import { HOSTED_CAMPAIGN_TARGET } from "../src/hosted-campaign-coordinator.js";

const expectation = (path: string) => ({
  armedPath: `${path}.armed`,
  campaignId: "campaign-1",
  path,
  runId: "run-1",
  scenario: "sequential" as const,
  phase: "connection" as const,
});

const gate = (overrides: Record<string, unknown> = {}) => ({
  campaignId: "campaign-1",
  releasedAtEpochMs: Date.now(),
  runId: "run-1",
  scenario: "sequential",
  schemaVersion: 1,
  phase: "connection",
  target: {
    guildId: HOSTED_CAMPAIGN_TARGET.guildId,
    mutationTarget: HOSTED_CAMPAIGN_TARGET.mutationTarget,
    voiceChannelId: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
  },
  ...overrides,
});

async function publishGate(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.partial`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await link(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

describe("hosted actor release gate", () => {
  it("does not connect any actor until the hosted release is accepted", async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let connectionCount = 0;
    const run = connectActorsAfterReleaseGate({
      releaseGate: {
        armedPath: "/private/release.armed.json",
        campaignId: "campaign-1",
        path: "/private/release.json",
        runId: "run-1",
        timeoutMilliseconds: 1_000,
      },
      scenario: "sequential",
    }, async () => {
      connectionCount += 1;
      return "connected";
    }, async () => waiting);

    await Promise.resolve();
    expect(connectionCount).toBe(0);
    release?.();
    await expect(run).resolves.toBe("connected");
    expect(connectionCount).toBe(1);
  });

  it("aborts without attempting an actor connection when release fails", async () => {
    let connectionCount = 0;
    const run = connectActorsAfterReleaseGate({
      releaseGate: {
        armedPath: "/private/release.armed.json",
        campaignId: "campaign-1",
        path: "/private/release.json",
        runId: "run-1",
        timeoutMilliseconds: 1_000,
      },
      scenario: "overlap",
    }, async () => {
      connectionCount += 1;
    }, async () => {
      throw new Error("release rejected");
    });

    await expect(run).rejects.toThrow("release rejected");
    expect(connectionCount).toBe(0);
  });

  it("preserves immediate connections outside hosted campaigns", async () => {
    let releaseWaitCount = 0;
    let connectionCount = 0;

    await expect(connectActorsAfterReleaseGate({
      releaseGate: undefined,
      scenario: "reconnect",
    }, async () => {
      connectionCount += 1;
      return "connected";
    }, async () => {
      releaseWaitCount += 1;
    })).resolves.toBe("connected");
    expect(releaseWaitCount).toBe(0);
    expect(connectionCount).toBe(1);
  });

  it("waits for a newly created private correlated gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "actor-release-gate-"));
    const path = join(root, "release.json");
    const waiting = waitForActorReleaseGate(expectation(path), AbortSignal.timeout(2_000));
    await waitForActorGateArmed(expectation(path), AbortSignal.timeout(2_000));

    await publishGate(path, gate());

    await expect(waiting).resolves.toBeUndefined();
  });

  it("rejects a gate that existed before the actor started waiting", async () => {
    const root = await mkdtemp(join(tmpdir(), "actor-release-existing-"));
    const path = join(root, "release.json");
    await writeFile(path, JSON.stringify(gate()), { mode: 0o600 });

    await expect(waitForActorReleaseGate(expectation(path), AbortSignal.timeout(500)))
      .rejects.toThrow(/absent before waiting/u);
  });

  it.each([
    ["wrong run", { runId: "run-2" }, /correlation/u],
    ["wrong scenario", { scenario: "overlap" }, /correlation/u],
    ["wrong target", { target: {
      guildId: HOSTED_CAMPAIGN_TARGET.guildId,
      mutationTarget: HOSTED_CAMPAIGN_TARGET.mutationTarget,
      voiceChannelId: "22222222222222222",
    } }, /Invalid input/u],
    ["extra field", { extra: true }, /Unrecognized key/u],
    ["stale timestamp", { releasedAtEpochMs: 1 }, /not fresh/u],
  ])("rejects %s", async (_name, overrides, expectedError) => {
    const root = await mkdtemp(join(tmpdir(), "actor-release-invalid-"));
    const path = join(root, "release.json");
    const waiting = waitForActorReleaseGate(expectation(path), AbortSignal.timeout(2_000));
    await waitForActorGateArmed(expectation(path), AbortSignal.timeout(2_000));
    await publishGate(path, gate(overrides));

    await expect(waiting).rejects.toThrow(expectedError);
  });

  it("rejects symlinks and non-private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "actor-release-security-"));
    const actual = join(root, "actual.json");
    const linked = join(root, "linked.json");
    await writeFile(actual, JSON.stringify(gate()), { mode: 0o600 });
    const symlinkWait = waitForActorReleaseGate(expectation(linked), AbortSignal.timeout(2_000));
    const symlinkAssertion = expect(symlinkWait).rejects.toThrow(/non-symlink/u);
    await waitForActorGateArmed(expectation(linked), AbortSignal.timeout(2_000));
    await symlink(actual, linked);
    await symlinkAssertion;

    const publicPath = join(root, "public.json");
    const publicWait = waitForActorReleaseGate(expectation(publicPath), AbortSignal.timeout(2_000));
    const publicAssertion = expect(publicWait).rejects.toThrow(/0600/u);
    await waitForActorGateArmed(expectation(publicPath), AbortSignal.timeout(2_000));
    await writeFile(publicPath, JSON.stringify(gate()), { mode: 0o644 });
    await publicAssertion;
  });

  it("honors an abortable bounded wait", async () => {
    const root = await mkdtemp(join(tmpdir(), "actor-release-timeout-"));
    const path = join(root, "release.json");

    await expect(waitForActorReleaseGate(expectation(path), AbortSignal.timeout(20)))
      .rejects.toThrow(/Timed out or aborted/u);
  });

  it("rejects an unsafe actor armed receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "actor-armed-security-"));
    const expected = expectation(join(root, "gate.json"));
    await writeFile(expected.armedPath, "{}\n", { mode: 0o600 });
    await chmod(expected.armedPath, 0o644);
    await expect(waitForActorGateArmed(expected, AbortSignal.timeout(100)))
      .rejects.toThrow(/private regular file/u);
  });
});
