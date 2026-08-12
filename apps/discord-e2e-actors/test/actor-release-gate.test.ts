import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { waitForActorReleaseGate } from "../src/actor-release-gate.js";
import { HOSTED_CAMPAIGN_TARGET } from "../src/hosted-campaign-coordinator.js";

const expectation = (path: string) => ({
  campaignId: "campaign-1",
  path,
  runId: "run-1",
  scenario: "sequential" as const,
});

const gate = (overrides: Record<string, unknown> = {}) => ({
  campaignId: "campaign-1",
  releasedAtEpochMs: Date.now(),
  runId: "run-1",
  scenario: "sequential",
  schemaVersion: 1,
  target: {
    guildId: HOSTED_CAMPAIGN_TARGET.guildId,
    mutationTarget: HOSTED_CAMPAIGN_TARGET.mutationTarget,
    voiceChannelId: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
  },
  ...overrides,
});

describe("hosted actor release gate", () => {
  it("waits for a newly created private correlated gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "actor-release-gate-"));
    const path = join(root, "release.json");
    const waiting = waitForActorReleaseGate(expectation(path), AbortSignal.timeout(2_000));

    await writeFile(path, JSON.stringify(gate()), { encoding: "utf8", flag: "wx", mode: 0o600 });

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
    await writeFile(path, JSON.stringify(gate(overrides)), { mode: 0o600 });

    await expect(waiting).rejects.toThrow(expectedError);
  });

  it("rejects symlinks and non-private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "actor-release-security-"));
    const actual = join(root, "actual.json");
    const linked = join(root, "linked.json");
    await writeFile(actual, JSON.stringify(gate()), { mode: 0o600 });
    const symlinkWait = waitForActorReleaseGate(expectation(linked), AbortSignal.timeout(2_000));
    const symlinkAssertion = expect(symlinkWait).rejects.toThrow(/non-symlink/u);
    await symlink(actual, linked);
    await symlinkAssertion;

    const publicPath = join(root, "public.json");
    const publicWait = waitForActorReleaseGate(expectation(publicPath), AbortSignal.timeout(2_000));
    const publicAssertion = expect(publicWait).rejects.toThrow(/0600/u);
    await writeFile(publicPath, JSON.stringify(gate()), { mode: 0o644 });
    await publicAssertion;
  });

  it("honors an abortable bounded wait", async () => {
    const root = await mkdtemp(join(tmpdir(), "actor-release-timeout-"));
    const path = join(root, "release.json");

    await expect(waitForActorReleaseGate(expectation(path), AbortSignal.timeout(20)))
      .rejects.toThrow(/Timed out or aborted/u);
  });
});
