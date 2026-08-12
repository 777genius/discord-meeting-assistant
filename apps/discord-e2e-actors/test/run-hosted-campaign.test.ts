import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  HOSTED_CAMPAIGN_TARGET,
  type HostedCampaignChildHandle,
  type HostedCampaignLeaseHandle,
} from "../src/hosted-campaign-coordinator.js";
import { campaignActions } from "../src/hosted-campaign-execution-graph.js";
import { parseHostedCampaignArguments, parseHostedCampaignPlan } from "../src/hosted-campaign-run-config.js";
import {
  loadHostedCampaignTrustedRuntimeEnvironment,
  readPrivateHostedCampaignPlan,
  runHostedCampaignCli,
  writeCreateOnlyHostedCampaignReceipt,
} from "../src/run-hosted-campaign.js";

const plan = () => {
  const runs = [
    { ordinal: 1, scenario: "sequential", campaignId: "campaign-1", runId: "run-1", retainedCaptureCount: 0 },
    { ordinal: 2, scenario: "overlap", campaignId: "campaign-1", runId: "run-2", retainedCaptureCount: 0 },
    { ordinal: 3, scenario: "reconnect", campaignId: "campaign-1", runId: "run-3", retainedCaptureCount: 6 },
  ] as const;
  const skeleton = { children: [], target: HOSTED_CAMPAIGN_TARGET,
    thresholds: { answerFirstPacketMilliseconds: 4_000 }, runs };
  return ({
  children: [{ arguments: { kind: "environment" }, childId: "observer", entrypoint: "live-observer" as const, environment: {
    DISCORD_E2E_OUTPUT: "/private/evidence/observer.json",
  }, produces: campaignActions(skeleton).map((reference, index) => ({
    ...reference, outputPath: `/private/evidence/action-${index}.json`,
  })), requires: [], startBefore: { kind: "campaign" as const } }],
  target: HOSTED_CAMPAIGN_TARGET,
  thresholds: { answerFirstPacketMilliseconds: 4_000 },
  runs,
  });
};

describe("run-hosted-campaign CLI", () => {
  it("selects only the closed trusted runtime environment", () => {
    expect(loadHostedCampaignTrustedRuntimeEnvironment({
      HOME: "/private/tmp/test-home",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      SECRET_SHOULD_NOT_REACH_CHILD: "secret-value",
      SSH_AUTH_SOCK: "/private/tmp/test-agent.sock",
    })).toEqual({
      HOME: "/private/tmp/test-home",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      SSH_AUTH_SOCK: "/private/tmp/test-agent.sock",
    });
    expect(loadHostedCampaignTrustedRuntimeEnvironment({
      HOME: "/private/tmp/test-home",
      PATH: "/usr/bin:/bin",
    })).toEqual({ HOME: "/private/tmp/test-home", PATH: "/usr/bin:/bin" });
  });

  it("requires exactly three arguments and absolute plan/receipt paths", () => {
    expect(parseHostedCampaignArguments(["/plan.json", "/receipt.json", "1000"])).toEqual({
      planPath: "/plan.json", receiptPath: "/receipt.json", timeoutMilliseconds: 1_000,
    });
    expect(() => parseHostedCampaignArguments(["/plan.json", "/receipt.json"])).toThrow(/Usage/u);
    expect(() => parseHostedCampaignArguments(["plan.json", "/receipt.json", "1000"])).toThrow(/absolute/u);
  });

  it("strictly validates the closed executable plan", () => {
    expect(parseHostedCampaignPlan(plan()).children[0]?.entrypoint).toBe("live-observer");
    expect(() => parseHostedCampaignPlan({ ...plan(), children: [{ ...plan().children[0], command: "sh" }] }))
      .toThrow();
    expect(() => parseHostedCampaignPlan({ ...plan(), thresholds: undefined })).toThrow();
    expect(() => parseHostedCampaignPlan({
      ...plan(), children: [{ ...plan().children[0], startBefore: "run-verified" }],
    })).toThrow();
    expect(() => parseHostedCampaignPlan({
      ...plan(), thresholds: { answerFirstPacketMilliseconds: Number.MAX_SAFE_INTEGER + 1 },
    })).toThrow();
  });

  it("accepts the closed recording-ready entrypoint", () => {
    const input = plan();
    expect(parseHostedCampaignPlan({ ...input, children: [{
      ...input.children[0]!, entrypoint: "recording-ready",
    }] }).children[0]?.entrypoint).toBe("recording-ready");
  });

  it("accepts only closed recording-ready environment bindings", () => {
    const input = plan();
    const source = { action: { kind: "recording-ready", ordinal: 1, runId: "run-1" }, ordinal: 1, runId: "run-1" };
    const child = input.children[0]!;
    const valid = { ...child, environmentBindings: [{
      name: "DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID",
      valueFrom: { actionRef: source, field: "recordingId" },
    }] };
    expect(parseHostedCampaignPlan({ ...input, children: [valid] }).children[0]?.environmentBindings).toHaveLength(1);
    expect(() => parseHostedCampaignPlan({ ...input, children: [{ ...child, environmentBindings: [{
      name: "PATH", valueFrom: { actionRef: source, field: "recordingId" },
    }] }] })).toThrow();
    expect(() => parseHostedCampaignPlan({ ...input, children: [{ ...child, environmentBindings: [{
      name: "DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID", valueFrom: { actionRef: source, field: "nested.value" },
    }] }] })).toThrow();
  });

  it("accepts a provenance producer bound to one campaign snapshot", () => {
    const input = plan();
    input.children[0] = {
      arguments: { kind: "environment" }, childId: "provenance-before", entrypoint: "provenance-probe",
      environment: {
        DISCORD_E2E_PROVENANCE_CAMPAIGN_ID: "campaign-1", DISCORD_E2E_PROVENANCE_PHASE: "before",
        DISCORD_E2E_PROVENANCE_RUN_IDS_JSON: '["run-1","run-2","run-3"]',
        DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH: "/private/evidence/provenance.json",
      },
      completion: {
        action: { kind: "provenance-before" }, campaignId: "campaign-1", kind: "provenance-probe",
        phase: "before", runIds: ["run-1", "run-2", "run-3"],
        snapshotPath: "/private/evidence/provenance.json",
      },
      produces: [{
        action: { kind: "provenance-before" }, ordinal: 1,
        outputPath: "/private/evidence/provenance-before.json", runId: "run-1",
      }],
      requires: [],
      startBefore: { action: { kind: "provenance-before" }, kind: "barrier", ordinal: 1, runId: "run-1" },
    } as never;
    expect(parseHostedCampaignPlan(input).children[0]?.entrypoint).toBe("provenance-probe");
  });

  it("reads only an owned regular 0600 plan and writes a create-only 0600 receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hosted-campaign-cli-"));
    const planPath = join(directory, "plan.json");
    const receiptPath = join(directory, "receipt.json");
    await writeFile(planPath, JSON.stringify(plan()), { mode: 0o600 });
    expect(await readPrivateHostedCampaignPlan(planPath)).toEqual(plan());
    await chmod(planPath, 0o644);
    await expect(readPrivateHostedCampaignPlan(planPath)).rejects.toThrow(/0600/u);

    const receipt = { actionEvidence: [], campaignId: "campaign-1", runIds: ["run-1", "run-2", "run-3"], schemaVersion: 1, teardownComplete: true } as const;
    await writeCreateOnlyHostedCampaignReceipt(receiptPath, receipt);
    expect((await lstat(receiptPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(receipt);
    await expect(writeCreateOnlyHostedCampaignReceipt(receiptPath, receipt)).rejects.toThrow();
  });

  it("writes no receipt when a barrier fails", async () => {
    let written = false;
    const dependencies = {
      now: () => Date.now(),
      readPlan: async () => plan(),
      writeReceipt: async () => { written = true; },
      ports: {
        acquireCampaignLease: async (campaignId: string) => ({ campaignId }) as HostedCampaignLeaseHandle,
        awaitChildCompletion: async () => {},
        publishReleaseGate: async () => {},
        publishSupplementalGate: async () => {},
        startChild: async ({ childId }: { childId: string }) => ({ childId }) as HostedCampaignChildHandle,
        awaitBarrier: async () => { throw new Error("barrier failed"); },
        releaseCampaignLease: async () => {},
        stopChild: async () => {},
      },
    };
    await expect(runHostedCampaignCli(
      ["/plan.json", "/receipt.json", "1000"], dependencies, new AbortController().signal,
    )).rejects.toThrow("barrier failed");
    expect(written).toBe(false);
  });
});
