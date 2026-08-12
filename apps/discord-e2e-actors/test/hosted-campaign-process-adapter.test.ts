import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HostedCampaignArtifactStore } from "../src/hosted-campaign-artifact-store.js";
import { HostedCampaignProcessAdapter } from "../src/hosted-campaign-process-adapter.js";

async function adapter(source: string) {
  const root = await mkdtemp(join(tmpdir(), "hosted-process-"));
  await chmod(root, 0o700);
  await writeFile(join(root, "main.js"), source, { mode: 0o600 });
  const storeRoot = join(root, "artifacts");
  const store = new HostedCampaignArtifactStore(storeRoot, "campaign-1");
  await store.initialize();
  return new HostedCampaignProcessAdapter({ artifactStore: store, distRoot: root, terminationGraceMilliseconds: 50 });
}
const bounded = () => ({ deadlineEpochMilliseconds: Date.now() + 1_000, signal: new AbortController().signal });
const spec = (environment: Readonly<Record<string, string>> = {}) => ({
  arguments: { kind: "environment" as const }, childId: "actor", entrypoint: "actor" as const,
  environment, startBefore: "campaign" as const,
});

describe("hosted campaign process adapter", () => {
  it("uses a fresh allowlisted environment and rejects dangerous inheritance", async () => {
    const processAdapter = await adapter("setInterval(() => {}, 1000)");
    await expect(processAdapter.startChild(spec({ PATH: "/bin" }), bounded())).rejects.toThrow(/PATH/u);
    await expect(processAdapter.startChild(spec({ NODE_OPTIONS: "--inspect" }), bounded())).rejects.toThrow(/NODE_OPTIONS/u);
    await expect(processAdapter.startChild(spec({ UNKNOWN: "x" }), bounded())).rejects.toThrow(/UNKNOWN/u);
    const handle = await processAdapter.startChild(spec({ DISCORD_E2E_RUN_ID: "sandbox" }), bounded());
    await processAdapter.stopChild(handle);
  });

  it("rejects early nonzero exit", async () => {
    const processAdapter = await adapter("process.exit(7)");
    await expect(processAdapter.startChild(spec(), bounded())).rejects.toThrow(/exited early/u);
  });

  it("publishes an exact create-only actor release gate", async () => {
    const processAdapter = await adapter("setInterval(() => {}, 1000)");
    const root = await mkdtemp(join(tmpdir(), "hosted-release-"));
    const path = join(root, "gate.json");
    const executable = spec({
      DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: "campaign-1",
      DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: path,
      DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS: "1000",
      DISCORD_E2E_RUN_ID: "run-1",
      DISCORD_E2E_SCENARIO: "sequential",
    });
    await processAdapter.publishReleaseGate(executable, bounded());
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      campaignId: "campaign-1", runId: "run-1", scenario: "sequential", schemaVersion: 1,
      target: { guildId: "1533228590643155034", mutationTarget: "test-only", voiceChannelId: "1533228823045214398" },
    });
    await expect(processAdapter.publishReleaseGate(executable, bounded())).rejects.toMatchObject({ code: "EEXIST" });
  });
});
