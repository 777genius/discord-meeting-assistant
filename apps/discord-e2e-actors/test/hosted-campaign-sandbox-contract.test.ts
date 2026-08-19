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
  type HostedCampaignBarrierAction,
} from "../src/hosted-campaign-coordinator.js";
import { campaignActions } from "../src/hosted-campaign-execution-graph.js";
import { retainedE2eEvidenceSchema, verifyE2eCampaign } from "../src/e2e-evidence.js";
import { writeCreateOnlyHostedCampaignReceipt } from "../src/run-hosted-campaign.js";
import {
  currentExpectedRevisions,
  manifest,
} from "./e2e-evidence-fixtures.js";
import { currentV10Campaign } from "./e2e-evidence-v10-fixtures.js";
import { HostedCampaignSandboxAdapter } from "./hosted-campaign-sandbox-adapter.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hosted-campaign-child.mjs");
const cleanupRoots: string[] = [];
const SUCCESSFUL_PROCESS_CAMPAIGN_DEADLINE_MILLISECONDS = 10_000;
const PROCESS_CONTRACT_TEST_TIMEOUT_MILLISECONDS = 15_000;

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map(async (path) => rm(path, { force: true, recursive: true })));
});

function input(behavior = "ack"): HostedCampaignInput {
  const runs = [
    { campaignId: "campaign-sandbox", ordinal: 1, retainedCaptureCount: 0, runId: "run-sequential", scenario: "sequential" },
    { campaignId: "campaign-sandbox", ordinal: 2, retainedCaptureCount: 0, runId: "run-overlap", scenario: "overlap" },
    { campaignId: "campaign-sandbox", ordinal: 3, retainedCaptureCount: 6, runId: "run-reconnect", scenario: "reconnect" },
  ] as const;
  const skeleton = { children: [], runs, target: HOSTED_CAMPAIGN_TARGET,
    thresholds: { answerFirstPacketMilliseconds: 4_000 } };
  const actions = campaignActions(skeleton);
  const productions = (kind: HostedCampaignBarrierAction["kind"]) => actions
    .filter(({ action }) => action.kind === kind)
    .map((reference, index) => ({
      ...reference, outputPath: `/sandbox/${reference.action.kind}-${index}.json`,
    }));
  const provenanceProducer = (phase: "after" | "before") => {
    const produced = productions(`provenance-${phase}`)[0]!;
    const action = produced.action as Extract<HostedCampaignBarrierAction, {
      readonly kind: "provenance-after" | "provenance-before";
    }>;
    const snapshotPath = `/sandbox/provenance-${phase}.json`;
    return completionChild({
      arguments: { kind: "environment" }, childId: `provenance-${phase}`,
      completion: { action, campaignId: "campaign-sandbox", kind: "provenance-probe", phase,
        runIds: ["run-sequential", "run-overlap", "run-reconnect"], snapshotPath },
      entrypoint: "provenance-probe",
      environment: {
        DISCORD_E2E_PROVENANCE_CAMPAIGN_ID: "campaign-sandbox", DISCORD_E2E_PROVENANCE_PHASE: phase,
        DISCORD_E2E_PROVENANCE_RUN_IDS_JSON: '["run-sequential","run-overlap","run-reconnect"]',
        DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH: snapshotPath,
      },
      produced,
    });
  };
  const serviceLevels = productions("service-levels-ready")[0]!;
  const serviceLevelsAction = serviceLevels.action as Extract<HostedCampaignBarrierAction, {
    readonly kind: "service-levels-ready";
  }>;
  const campaignVerified = productions("campaign-verified")[0]!;
  const campaignVerifiedAction = campaignVerified.action as Extract<HostedCampaignBarrierAction, {
    readonly kind: "campaign-verified";
  }>;
  return {
    ...skeleton,
    children: [
      { arguments: { kind: "environment" }, childId: "observer", entrypoint: "conversation-observer" as const,
        environment: { FIXTURE_BEHAVIOR: behavior }, produces: [
          ...productions("observer-subscribed"), ...productions("capture-retained"),
          ...productions("answer-intent"), ...productions("answer-observer-ready"),
          ...productions("answer-first-packet"),
        ], requires: [], startBefore: { kind: "campaign" as const } },
      { arguments: { kind: "environment" }, childId: "speaker-a", entrypoint: "actor" as const,
        environment: {}, produces: [...productions("reconnect-left"), ...productions("reconnect-ready")], requires: [],
        startBefore: { kind: "campaign" as const } },
      { arguments: { kind: "environment" }, childId: "speaker-b", entrypoint: "live-observer" as const,
        environment: {}, produces: [], requires: [],
        startBefore: { kind: "campaign" as const } },
      provenanceProducer("before"),
      ...productions("run-verified").map((produced) => completionChild({
        arguments: { evidencePath: `/sandbox/${produced.runId}.json`, kind: "evidence-verifier",
          manifestPath: "/sandbox/manifest.json" },
        childId: `verifier-${produced.ordinal}`,
        completion: { action: produced.action as Extract<HostedCampaignBarrierAction, {
          readonly kind: "run-verified";
        }>, kind: "evidence-verifier" },
        entrypoint: "evidence-verifier", environment: {}, produced,
      })),
      completionChild({
        arguments: { kind: "environment" }, childId: "service-levels",
        completion: { action: serviceLevelsAction, campaignId: "campaign-sandbox", kind: "service-levels",
          meetingId: "meeting-sandbox", outputPath: "/sandbox/service-levels.json",
          recordingId: "recording-sandbox", reportPath: "/sandbox/service-levels-report.json",
          runId: "run-reconnect" },
        entrypoint: "service-levels",
        environment: {
          DISCORD_E2E_SLA_CAMPAIGN_ID: "campaign-sandbox", DISCORD_E2E_SLA_MEETING_ID: "meeting-sandbox",
          DISCORD_E2E_SLA_OUTPUT: "/sandbox/service-levels.json",
          DISCORD_E2E_SLA_RECORDING_ID: "recording-sandbox",
          DISCORD_E2E_SLA_REPORT_OUTPUT: "/sandbox/service-levels-report.json",
          DISCORD_E2E_SLA_RUN_ID: "run-reconnect",
        },
        produced: serviceLevels,
      }),
      provenanceProducer("after"),
      completionChild({
        arguments: { evidencePaths: ["/sandbox/1.json", "/sandbox/2.json", "/sandbox/3.json"],
          kind: "campaign-verifier", manifestPath: "/sandbox/manifest.json" },
        childId: "campaign-verifier",
        completion: { action: campaignVerifiedAction, campaignId: "campaign-sandbox",
          kind: "campaign-verifier", runIds: ["run-sequential", "run-overlap", "run-reconnect"] },
        entrypoint: "campaign-verifier", environment: {}, produced: campaignVerified,
      }),
    ],
  };
}

function completionChild({
  arguments: arguments_, childId, completion, entrypoint, environment, produced,
}: {
  readonly arguments: HostedCampaignInput["children"][number]["arguments"];
  readonly childId: string;
  readonly completion: NonNullable<HostedCampaignInput["children"][number]["completion"]>;
  readonly entrypoint: HostedCampaignInput["children"][number]["entrypoint"];
  readonly environment: Readonly<Record<string, string>>;
  readonly produced: HostedCampaignInput["children"][number]["produces"][number];
}): HostedCampaignInput["children"][number] {
  return {
    arguments: arguments_, childId, completion, entrypoint, environment, produces: [produced], requires: [],
    startBefore: { action: produced.action, kind: "barrier", ordinal: produced.ordinal, runId: produced.runId },
  };
}

async function sandbox(behavior = "ack") {
  const parent = await mkdtemp(join(tmpdir(), "hosted-campaign-sandbox-"));
  cleanupRoots.push(parent);
  await chmod(parent, 0o700);
  const rootPath = join(parent, "barriers");
  await createCampaignBarrierRoot(rootPath);
  const [sequential, overlap, reconnect] = currentV10Campaign();
  if (sequential === undefined || overlap === undefined || reconnect === undefined) {
    throw new Error("Current V10 campaign fixtures are required");
  }
  const sources = [sequential, overlap, reconnect] as const;
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
      "provenance-before", "run-verified:1:run-sequential", "run-verified:2:run-overlap",
      "observer-subscribed",
      "capture-retained:1", "capture-retained:2", "capture-retained:3", "capture-retained:4",
      "reconnect-left", "reconnect-ready", "answer-intent", "answer-observer-ready",
      "answer-first-packet", "capture-retained:5", "capture-retained:6", "service-levels-ready",
      "run-verified:3:run-reconnect", "provenance-after", "campaign-verified",
    ]);
    expect(context.adapter.stoppedChildren.toSorted()).toEqual(input().children.map(({ childId }) => childId).toSorted());
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
    expect(context.adapter.stoppedChildren.toSorted()).toEqual(context.adapter.startedChildren.toSorted());
    expect(context.adapter.activeChildCount).toBe(0);
    await expect(readFile(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces child failure and still stops every started child", async () => {
    const context = await sandbox("exit");
    await expect(runHostedCampaign(input("exit"), context.adapter, bounded()))
      .rejects.toThrow(/exited before acknowledgement/u);
    expect(context.adapter.stoppedChildren.toSorted()).toEqual(context.adapter.startedChildren.toSorted());
    expect(context.adapter.activeChildCount).toBe(0);
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
