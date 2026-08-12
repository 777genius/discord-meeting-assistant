import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createCampaignBarrierRoot } from "../src/campaign-barrier.js";
import {
  HOSTED_CAMPAIGN_TARGET,
  runHostedCampaign,
  type HostedCampaignInput,
} from "../src/hosted-campaign-coordinator.js";
import { retainedE2eEvidenceSchema, verifyE2eCampaign } from "../src/e2e-evidence.js";
import { writeCreateOnlyHostedCampaignReceipt } from "../src/run-hosted-campaign.js";
import {
  currentExpectedRevisions,
  manifest,
  overlapEvidence,
  reidentify,
  retainedV6Evidence,
  retainedV8Evidence,
  sequentialEvidence,
} from "./e2e-evidence-fixtures.js";
import { HostedCampaignSandboxAdapter } from "./hosted-campaign-sandbox-adapter.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hosted-campaign-child.mjs");
const cleanupRoots: string[] = [];
const SUCCESSFUL_PROCESS_CAMPAIGN_DEADLINE_MILLISECONDS = 10_000;
const PROCESS_CONTRACT_TEST_TIMEOUT_MILLISECONDS = 15_000;

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map(async (path) => rm(path, { force: true, recursive: true })));
});

function input(behavior = "ack"): HostedCampaignInput {
  return {
    children: ["observer", "speaker-a", "speaker-b"].map((childId) => ({
      arguments: { kind: "environment" }, childId, entrypoint: "actor" as const,
      environment: childId === "observer" ? { FIXTURE_BEHAVIOR: behavior } : {},
      startBefore: "campaign" as const,
    })),
    runs: [
      { campaignId: "campaign-sandbox", ordinal: 1, retainedCaptureCount: 0, runId: "run-sequential", scenario: "sequential" },
      { campaignId: "campaign-sandbox", ordinal: 2, retainedCaptureCount: 0, runId: "run-overlap", scenario: "overlap" },
      { campaignId: "campaign-sandbox", ordinal: 3, retainedCaptureCount: 6, runId: "run-reconnect", scenario: "reconnect" },
    ],
    target: HOSTED_CAMPAIGN_TARGET,
    thresholds: { answerFirstPacketMilliseconds: 4_000 },
  };
}

async function sandbox(behavior = "ack") {
  const parent = await mkdtemp(join(tmpdir(), "hosted-campaign-sandbox-"));
  cleanupRoots.push(parent);
  await chmod(parent, 0o700);
  const rootPath = join(parent, "barriers");
  await createCampaignBarrierRoot(rootPath);
  const sources = [
    reidentify(retainedV6Evidence(sequentialEvidence()), "sandbox-sequential"),
    reidentify(retainedV6Evidence(overlapEvidence()), "sandbox-overlap"),
    reidentify(retainedV8Evidence(), "sandbox-reconnect"),
  ] as const;
  const writeRunFile = async (source: (typeof sources)[number], index: number) => {
    const sourcePath = join(parent, `source-${index + 1}.json`);
    const outputPath = join(parent, `retained-${index + 1}.json`);
    await writeFile(sourcePath, JSON.stringify(source), { encoding: "utf8", mode: 0o600 });
    return { outputPath, sourcePath };
  };
  const runFiles = await Promise.all([
    writeRunFile(sources[0], 0), writeRunFile(sources[1], 1), writeRunFile(sources[2], 2),
  ]);
  let verificationCount = 0;
  const adapter = new HostedCampaignSandboxAdapter({
    fixturePath,
    rootPath,
    runFiles,
    verifyCampaign: (rawOutputs) => {
      verificationCount += 1;
      const runs = rawOutputs.map((raw) => retainedE2eEvidenceSchema.parse(raw));
      return verifyE2eCampaign(manifest(), runs, currentExpectedRevisions).passed;
    },
  });
  return { adapter, parent, rootPath, runFiles, verificationCount: () => verificationCount, behavior };
}

function bounded(timeoutMilliseconds = 5_000) {
  return { deadlineEpochMilliseconds: Date.now() + timeoutMilliseconds, signal: new AbortController().signal };
}

async function runAndWriteReceipt(
  context: Awaited<ReturnType<typeof sandbox>>,
  campaignInput: HostedCampaignInput,
  receiptPath: string,
  timeoutMilliseconds = 5_000,
) {
  const receipt = await runHostedCampaign(campaignInput, context.adapter, bounded(timeoutMilliseconds));
  await writeCreateOnlyHostedCampaignReceipt(receiptPath, receipt);
  return receipt;
}

describe("hosted campaign sandbox process contract", () => {
  it("executes causal scenario actions and verifies three child-retained outputs", async () => {
    const context = await sandbox();
    const receipt = await runHostedCampaign(
      input(),
      context.adapter,
      bounded(SUCCESSFUL_PROCESS_CAMPAIGN_DEADLINE_MILLISECONDS),
    );

    expect(receipt).toMatchObject({ campaignId: "campaign-sandbox", teardownComplete: true });
    expect(context.verificationCount()).toBe(1);
    expect(context.adapter.actionLog).toEqual([
      "provenance-before", "observer-subscribed",
      "run-verified:1:run-sequential", "run-verified:2:run-overlap",
      "capture-retained:1", "capture-retained:2", "capture-retained:3", "capture-retained:4",
      "reconnect-left", "reconnect-ready", "answer-intent", "answer-observer-ready",
      "answer-first-packet", "capture-retained:5", "capture-retained:6",
      "run-verified:3:run-reconnect", "provenance-after", "campaign-verified",
    ]);
    expect(context.adapter.stoppedChildren.toSorted()).toEqual(["observer", "speaker-a", "speaker-b"]);
    for (const { outputPath } of context.runFiles) {
      expect(retainedE2eEvidenceSchema.safeParse(JSON.parse(await readFile(outputPath, "utf8"))).success).toBe(true);
      expect((await lstat(outputPath)).mode & 0o777).toBe(0o600);
    }
    expect((await lstat(context.rootPath)).mode & 0o777).toBe(0o700);
  }, PROCESS_CONTRACT_TEST_TIMEOUT_MILLISECONDS);

  it("times out a non-acknowledging child, cleans up, and creates no partial receipt", async () => {
    const context = await sandbox("hang");
    const receiptPath = join(context.parent, "receipt.json");
    await expect(runAndWriteReceipt(context, input("hang"), receiptPath, 1_000))
      .rejects.toThrow(/deadline expired/u);
    expect(context.adapter.stoppedChildren.toSorted()).toEqual(["observer", "speaker-a", "speaker-b"]);
    await expect(readFile(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces child failure and still stops every started child", async () => {
    const context = await sandbox("exit");
    await expect(runHostedCampaign(input("exit"), context.adapter, bounded()))
      .rejects.toThrow(/exited before acknowledgement/u);
    expect(context.adapter.stoppedChildren.toSorted()).toEqual(["observer", "speaker-a", "speaker-b"]);
  });

  it("rejects a concurrent campaign lease and permits a later clean run", async () => {
    const first = await sandbox();
    const second = new HostedCampaignSandboxAdapter({
      fixturePath, rootPath: first.rootPath, runFiles: first.runFiles, verifyCampaign: () => true,
    });
    await first.adapter.acquireCampaignLease("campaign-sandbox", bounded());
    await expect(second.acquireCampaignLease("campaign-sandbox", bounded())).rejects.toMatchObject({ code: "EEXIST" });
    await first.adapter.releaseCampaignLease();

    const receiptPath = join(first.parent, "receipt.json");
    await runAndWriteReceipt(
      first,
      input(),
      receiptPath,
      SUCCESSFUL_PROCESS_CAMPAIGN_DEADLINE_MILLISECONDS,
    );
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({ teardownComplete: true });
  }, PROCESS_CONTRACT_TEST_TIMEOUT_MILLISECONDS);
});
