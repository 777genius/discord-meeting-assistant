import { lstat, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { HostedCampaignPassReceipt } from "../src/hosted-campaign-coordinator.js";
import { writeCreateOnlyHostedCampaignReceipt } from "../src/run-hosted-campaign.js";

const receipt: HostedCampaignPassReceipt = {
  actionEvidence: [],
  campaignId: "campaign-atomic-1",
  runIds: ["run-1", "run-2", "run-3"],
  schemaVersion: 1,
  teardownComplete: true,
};

describe("hosted campaign receipt publisher", () => {
  it("publishes one complete mode-0600 receipt and removes its temporary link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hosted-campaign-receipt-"));
    const path = join(directory, "receipt.json");

    await writeCreateOnlyHostedCampaignReceipt(path, receipt);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["receipt.json"]);
  });

  it("never replaces an existing partial receipt and cleans its private temporary file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hosted-campaign-receipt-"));
    const path = join(directory, "receipt.json");
    await writeFile(path, "{\"partial\":", { mode: 0o600 });

    await expect(writeCreateOnlyHostedCampaignReceipt(path, receipt)).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(path, "utf8")).toBe("{\"partial\":");
    expect(await readdir(directory)).toEqual(["receipt.json"]);
  });

  it("does not follow or replace an existing destination symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hosted-campaign-receipt-"));
    const protectedPath = join(directory, "protected.json");
    const path = join(directory, "receipt.json");
    await writeFile(protectedPath, "protected", { mode: 0o600 });
    await symlink(protectedPath, path);

    await expect(writeCreateOnlyHostedCampaignReceipt(path, receipt)).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(protectedPath, "utf8")).toBe("protected");
    expect((await readdir(directory)).toSorted()).toEqual(["protected.json", "receipt.json"]);
  });
});
