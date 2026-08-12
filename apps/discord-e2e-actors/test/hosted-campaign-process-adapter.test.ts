import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HostedCampaignArtifactStore } from "../src/hosted-campaign-artifact-store.js";
import { HOSTED_CAMPAIGN_TARGET, type HostedCampaignExecutableSpec } from "../src/hosted-campaign-coordinator.js";
import { HostedCampaignProcessAdapter } from "../src/hosted-campaign-process-adapter.js";

async function adapter(source: string, outputLimitBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "hosted-process-"));
  await chmod(root, 0o700);
  await Promise.all(["main.js", "verify-retained-evidence.js", "verify-campaign.js", "collect-retained-evidence.js"]
    .map(async (name) => writeFile(join(root, name), source, { mode: 0o600 })));
  const storeRoot = join(root, "artifacts");
  const store = new HostedCampaignArtifactStore(storeRoot, "campaign-1");
  await store.initialize();
  return { processAdapter: new HostedCampaignProcessAdapter({
    artifactStore: store, distRoot: root, terminationGraceMilliseconds: 50,
    ...(outputLimitBytes === undefined ? {} : { outputLimitBytes }),
  }), store };
}
async function recordingReadyAdapter(source: string) {
  const root = await mkdtemp(join(tmpdir(), "hosted-recording-ready-process-"));
  await chmod(root, 0o700);
  await writeFile(join(root, "collect-recording-ready-receipt.js"), source, { mode: 0o600 });
  const store = new HostedCampaignArtifactStore(join(root, "artifacts"), "campaign-1");
  await store.initialize();
  return new HostedCampaignProcessAdapter({ artifactStore: store, distRoot: root, terminationGraceMilliseconds: 50 });
}
const bounded = () => ({ deadlineEpochMilliseconds: Date.now() + 1_000, signal: new AbortController().signal });
const spec = (
  environment: Readonly<Record<string, string>> = {}, releaseGate?: HostedCampaignExecutableSpec["releaseGate"],
): HostedCampaignExecutableSpec => ({
  arguments: { kind: "environment" as const }, childId: "actor", entrypoint: "actor" as const,
  environment: {
    DISCORD_E2E_GUILD_ID: HOSTED_CAMPAIGN_TARGET.guildId,
    DISCORD_E2E_VOICE_CHANNEL_ID: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
    ...environment,
  }, ...(releaseGate === undefined ? {} : { releaseGate }), startBefore: { kind: "campaign" as const },
});
const verifierSpec = (ordinal = 1, runId = "run-1"): HostedCampaignExecutableSpec => ({
  arguments: { evidencePath: "/evidence.json", kind: "evidence-verifier", manifestPath: "/manifest.json" },
  childId: `verifier-${ordinal}`,
  completion: { action: { kind: "run-verified", ordinal, runId }, kind: "evidence-verifier" },
  entrypoint: "evidence-verifier", environment: {},
  startBefore: { action: { kind: "run-verified", ordinal, runId }, kind: "barrier" },
});
const collectorSpec = (): HostedCampaignExecutableSpec => ({
  arguments: { kind: "environment" }, childId: "collector",
  completion: {
    action: { kind: "run-verified", ordinal: 1, runId: "run-1" }, evidencePath: "/evidence/run-1.json",
    kind: "collector", runId: "run-1",
  },
  entrypoint: "collector", environment: {
    DISCORD_E2E_EVIDENCE_OUTPUT: "/evidence/run-1.json", DISCORD_E2E_RUN_ID: "run-1",
  }, startBefore: { action: { kind: "run-verified", ordinal: 1, runId: "run-1" }, kind: "barrier" },
});
const campaignVerifierSpec = (): HostedCampaignExecutableSpec => ({
  arguments: {
    evidencePaths: ["/evidence/1.json", "/evidence/2.json", "/evidence/3.json"],
    kind: "campaign-verifier", manifestPath: "/manifest.json",
  }, childId: "campaign-verifier",
  completion: {
    action: { kind: "campaign-verified" }, campaignId: "campaign-1", kind: "campaign-verifier",
    runIds: ["run-1", "run-2", "run-3"],
  }, entrypoint: "campaign-verifier", environment: {},
  startBefore: { action: { kind: "campaign-verified" }, kind: "barrier" },
});
const campaignResult = (runIds: readonly string[]) => JSON.stringify({
  failures: [], passed: true,
  runResults: Object.fromEntries(runIds.map((runId) => [runId, { failures: [], metrics: [], passed: true }])),
});

describe("hosted campaign process adapter", () => {
  it("uses a fresh allowlisted environment and rejects dangerous inheritance", async () => {
    const { processAdapter } = await adapter("setInterval(() => {}, 1000)");
    await expect(processAdapter.startChild(spec({ PATH: "/bin" }), bounded())).rejects.toThrow(/PATH/u);
    await expect(processAdapter.startChild(spec({ NODE_OPTIONS: "--inspect" }), bounded())).rejects.toThrow(/NODE_OPTIONS/u);
    await expect(processAdapter.startChild(spec({ UNKNOWN: "x" }), bounded())).rejects.toThrow(/UNKNOWN/u);
    const handle = await processAdapter.startChild(spec({ DISCORD_E2E_RUN_ID: "sandbox" }), bounded());
    await processAdapter.stopChild(handle);
  });

  it("rejects mismatched pinned coordinates before spawning a child", async () => {
    const { processAdapter } = await adapter("setInterval(() => {}, 1000)");
    await expect(processAdapter.startChild(spec({ DISCORD_E2E_GUILD_ID: "999999999999999999" }), bounded()))
      .rejects.toThrow(/target mismatch.*GUILD_ID/u);
    await expect(processAdapter.startChild({
      arguments: { kind: "environment" }, childId: "observer", entrypoint: "live-observer",
      environment: {
        DISCORD_E2E_LIVE_RESULT_CHANNEL_ID: "999999999999999999",
        DISCORD_E2E_LIVE_SUT_APPLICATION_ID: HOSTED_CAMPAIGN_TARGET.sutApplicationId,
      }, startBefore: { kind: "campaign" },
    }, bounded())).rejects.toThrow(/target mismatch.*RESULT_CHANNEL_ID/u);
    await expect(processAdapter.startChild({
      arguments: { kind: "environment" }, childId: "collector", entrypoint: "collector",
      environment: {
        DISCORD_E2E_MUTATION_TARGET: HOSTED_CAMPAIGN_TARGET.mutationTarget,
        DISCORD_E2E_REMOTE_CRAIG_PROJECT: HOSTED_CAMPAIGN_TARGET.craigProject,
        DISCORD_E2E_REMOTE_HOST: "wrong-host",
        DISCORD_E2E_REMOTE_PROJECT: HOSTED_CAMPAIGN_TARGET.project,
      }, startBefore: { action: { kind: "provenance-before" }, kind: "barrier" },
    }, bounded())).rejects.toThrow(/target mismatch.*REMOTE_HOST/u);
  });

  it("rejects early nonzero exit", async () => {
    const { processAdapter } = await adapter("process.exit(7)");
    await processAdapter.startChild(spec(), bounded());
    await expect(processAdapter.awaitBarrier({ kind: "provenance-before" }, bounded()))
      .rejects.toThrow(/exited early/u);
  });

  it("publishes an exact create-only actor release gate", async () => {
    const { processAdapter } = await adapter("setInterval(() => {}, 1000)");
    const root = await mkdtemp(join(tmpdir(), "hosted-release-"));
    const path = join(root, "gate.json");
    const releaseGate = { action: { kind: "provenance-before" as const }, path };
    const executable = spec({
      DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: "campaign-1",
      DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: path,
      DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS: "1000",
      DISCORD_E2E_RUN_ID: "run-1",
      DISCORD_E2E_SCENARIO: "sequential",
    }, releaseGate);
    await processAdapter.publishReleaseGate(executable, bounded());
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      campaignId: "campaign-1", runId: "run-1", scenario: "sequential", schemaVersion: 1,
      target: { guildId: "1533228590643155034", mutationTarget: "test-only", voiceChannelId: "1533228823045214398" },
    });
    await expect(processAdapter.publishReleaseGate(executable, bounded())).rejects.toMatchObject({ code: "EEXIST" });
    await expect(processAdapter.publishReleaseGate({
      ...executable,
      releaseGate: { ...releaseGate, path: join(root, "other-gate.json") },
    }, bounded())).rejects.toThrow(/release gate path mismatch/u);
  });

  it("awaits a successful one-shot verifier and publishes its exact typed barrier", async () => {
    const { processAdapter, store } = await adapter(
      'process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:true}));',
    );
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await processAdapter.awaitChildCompletion(handle, executable, bounded());
    await expect(store.awaitAction(executable.completion!.action, bounded())).resolves.toEqual({
      ordinal: 1, runId: "run-1", verified: true,
    });
    await expect(processAdapter.awaitBarrier(executable.completion!.action, bounded())).resolves.toEqual({
      ordinal: 1, runId: "run-1", verified: true,
    });
  });

  it("fails closed on malformed or unsuccessful verification output", async () => {
    for (const source of [
      'process.stdout.write("not-json")',
      'process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:false}))',
    ]) {
      const { processAdapter } = await adapter(source);
      const executable = verifierSpec();
      const handle = await processAdapter.startChild(executable, bounded());
      await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).rejects.toThrow();
    }
  });

  it("rejects nonzero exit even when stdout claims verification passed", async () => {
    const { processAdapter } = await adapter(
      'process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:true})); process.exit(7);',
    );
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).rejects.toThrow(/failed \(7\)/u);
  });

  it("kills and rejects completion output beyond the configured bound", async () => {
    const { processAdapter } = await adapter('process.stdout.write("x".repeat(65));', 64);
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).rejects.toThrow(/stdout limit/u);
  });

  it("waits for fragmented stdout to drain before parsing completion", async () => {
    const { processAdapter } = await adapter(
      'process.stdout.write("{\\\"failures\\\":[],"); process.stdout.write("\\\"metrics\\\":[],\\\"passed\\\":true}");',
    );
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).resolves.toBeUndefined();
  });

  it("rejects stderr overflow without exposing buffered process output", async () => {
    const { processAdapter } = await adapter(
      'process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:true})); process.stderr.write("x".repeat(65));', 64,
    );
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).rejects.toThrow(/stderr limit/u);
  });

  it("binds collector completion to the exact evidence path and run ID", async () => {
    const good = JSON.stringify({
      evidencePath: "/evidence/run-1.json", metrics: [], recordingId: "recording-1", runId: "run-1", status: "passed",
    });
    const { processAdapter } = await adapter(`process.stdout.write(${JSON.stringify(good)});`);
    const executable = collectorSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).resolves.toBeUndefined();

    const bad = JSON.stringify({ ...JSON.parse(good), runId: "run-other" });
    const second = await adapter(`process.stdout.write(${JSON.stringify(bad)});`);
    const secondHandle = await second.processAdapter.startChild(executable, bounded());
    await expect(second.processAdapter.awaitChildCompletion(secondHandle, executable, bounded()))
      .rejects.toThrow(/correlation mismatch/u);
  });

  it("publishes campaign verification only for exactly the three configured passing runs", async () => {
    const executable = campaignVerifierSpec();
    const { processAdapter, store } = await adapter(`process.stdout.write(${JSON.stringify(campaignResult([
      "run-1", "run-2", "run-3",
    ]))});`);
    const handle = await processAdapter.startChild(executable, bounded());
    await processAdapter.awaitChildCompletion(handle, executable, bounded());
    await expect(store.awaitAction({ kind: "campaign-verified" }, bounded())).resolves.toEqual({ campaignId: "campaign-1" });

    const invalid = await adapter(`process.stdout.write(${JSON.stringify(campaignResult(["run-1", "run-2", "run-extra"]))});`);
    const invalidHandle = await invalid.processAdapter.startChild(executable, bounded());
    await expect(invalid.processAdapter.awaitChildCompletion(invalidHandle, executable, bounded()))
      .rejects.toThrow(/run results mismatch/u);
  });

  it("does not expose a run barrier before its one-shot completion", async () => {
    const { processAdapter, store } = await adapter(
      'setTimeout(() => process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:true})), 50);',
    );
    const executable = verifierSpec(2, "run-2");
    const handle = await processAdapter.startChild(executable, bounded());
    let visible = false;
    const waiting = (async () => {
      await store.awaitAction(executable.completion!.action, bounded());
      visible = true;
    })();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(visible).toBe(false);
    await processAdapter.awaitChildCompletion(handle, executable, bounded());
    await waiting;
    expect(visible).toBe(true);
  });

  it("maps the recording-ready entrypoint and passes only its required output coordinate", async () => {
    const processAdapter = await recordingReadyAdapter("setInterval(() => {}, 1000)");
    const handle = await processAdapter.startChild({
      ...spec({
        DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION: "d".repeat(40),
        DISCORD_E2E_READY_RECEIPT_OUTPUT: "/evidence/recording-ready.json",
      }),
      childId: "recording-ready",
      entrypoint: "recording-ready",
    }, bounded());
    await processAdapter.stopChild(handle);
  });
});
