import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HOSTED_CAMPAIGN_TARGET, type HostedCampaignChildHandle } from "../src/hosted-campaign-coordinator.js";
import { parseHostedCampaignArguments, parseHostedCampaignPlan } from "../src/hosted-campaign-run-config.js";
import {
  readPrivateHostedCampaignPlan,
  runHostedCampaignCli,
  writeCreateOnlyHostedCampaignReceipt,
} from "../src/run-hosted-campaign.js";

const plan = () => ({
  children: [{ arguments: [], childId: "observer", entrypoint: "live-observer", environment: {
    DISCORD_E2E_OUTPUT: "/private/evidence/observer.json",
  } }],
  target: HOSTED_CAMPAIGN_TARGET,
  runs: [
    { ordinal: 1, scenario: "sequential", campaignId: "campaign-1", runId: "run-1", retainedCaptureCount: 0 },
    { ordinal: 2, scenario: "overlap", campaignId: "campaign-1", runId: "run-2", retainedCaptureCount: 0 },
    { ordinal: 3, scenario: "reconnect", campaignId: "campaign-1", runId: "run-3", retainedCaptureCount: 6 },
  ],
});

describe("run-hosted-campaign CLI", () => {
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
        startChild: async ({ childId }: { childId: string }) => ({ childId }) as HostedCampaignChildHandle,
        awaitBarrier: async () => { throw new Error("barrier failed"); },
        stopChild: async () => {},
      },
    };
    await expect(runHostedCampaignCli(
      ["/plan.json", "/receipt.json", "1000"], dependencies, new AbortController().signal,
    )).rejects.toThrow("barrier failed");
    expect(written).toBe(false);
  });
});
