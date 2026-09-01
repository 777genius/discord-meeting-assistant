import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { digestCanonical } from "../src/hosted-campaign-local-admission.js";

import { assertCampaignLeaseCustodyMatches, parsePassVerificationArguments,
  verifyCampaignLeaseCleanupReceipt } from
  "../src/verify-hosted-campaign-pass.js";

describe("hosted campaign pass verification arguments", () => {
  it("requires the receipt, exact plan, and artifact root", () => {
    expect(parsePassVerificationArguments([
      "--", "/proof/pass.json", "/proof/plan.json", "/proof/artifacts",
    ])).toEqual({
      artifactRoot: "/proof/artifacts",
      planPath: "/proof/plan.json",
      receiptPath: "/proof/pass.json",
    });
    expect(() => parsePassVerificationArguments([
      "/proof/pass.json", "/proof/plan.json",
    ])).toThrow(/Usage/u);
    expect(() => parsePassVerificationArguments([
      "/proof/pass.json", "relative-plan.json", "/proof/artifacts",
    ])).toThrow(/Usage/u);
  });

  it("rejects standalone success while the live campaign lease still exists", async () => {
    const root = await campaignRoot();
    await writeFile(join(root, "barriers/campaign.lease"), "held\n", { mode: 0o600 });
    await expect(verifyCleanup(root)).rejects.toThrow(/lease remains present/u);
  });

  it("rejects a contradictory create-only lease cleanup receipt", async () => {
    const root = await campaignRoot();
    const content = { ...cleanupContent(root), inode: 999 };
    await writeFile(join(root, "control/campaign-lease-cleanup.json"), JSON.stringify({
      ...content, receiptSha256: digestCanonical(content),
    }), { mode: 0o600 });
    await expect(verifyCleanup(root)).rejects.toThrow(/contradicts retained/u);
  });

  it("rejects a recomputed lease cleanup object with an unknown field", async () => {
    const root = await campaignRoot();
    const content = { ...cleanupContent(root), unexpected: true };
    await writeFile(join(root, "control/campaign-lease-cleanup.json"), JSON.stringify({
      ...content, receiptSha256: digestCanonical(content),
    }), { mode: 0o600 });
    await expect(verifyCleanup(root)).rejects.toThrow(/contradicts retained/u);
  });

  it("accepts only the exact absent-lease cleanup identity", async () => {
    const root = await campaignRoot();
    const content = cleanupContent(root);
    await writeFile(join(root, "control/campaign-lease-cleanup.json"), JSON.stringify({
      ...content, receiptSha256: digestCanonical(content),
    }), { mode: 0o600 });
    await expect(verifyCleanup(root)).resolves.toBeUndefined();
  });

  it("rejects every contradictory retained lease identity across stack and pass receipts", () => {
    const root = "/private/campaign-1";
    const lease = { campaignRoot: root, device: 7, hostedPlanSha256: planDigest, inode: 8,
      leaseSha256: leaseDigest, receiptSha256: leaseReceiptDigest };
    const stack = { campaignLease: { device: 7, inode: 8, sha256: leaseDigest },
      campaignRoot: root, hostedPlanSha256: planDigest } as never;
    const pass = { campaignLease: { campaignRoot: root, device: 7, inode: 8,
      leaseSha256: leaseDigest, planSha256: planDigest, receiptSha256: leaseReceiptDigest } } as never;
    expect(() => { assertCampaignLeaseCustodyMatches({ artifactRoot: root, lease, pass, stack }); }).not.toThrow();
    for (const [field, changed] of [
      ["device", { device: 9 }], ["inode", { inode: 9 }], ["digest", { leaseSha256: "9".repeat(64) }],
      ["root", { campaignRoot: "/private/other" }], ["plan", { hostedPlanSha256: "9".repeat(64) }],
      ["receipt", { receiptSha256: "9".repeat(64) }],
    ] as const) {
      expect(() => { assertCampaignLeaseCustodyMatches({ artifactRoot: root,
        lease: { ...lease, ...changed }, pass, stack }); }, field).toThrow(/contradicts/u);
    }
  });
});

async function campaignRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hosted-pass-cleanup-"));
  await mkdir(join(root, "barriers"), { mode: 0o700 });
  await mkdir(join(root, "control"), { mode: 0o700 });
  return root;
}

const leaseDigest = "1".repeat(64);
const leaseReceiptDigest = "2".repeat(64);
const passDigest = "3".repeat(64);
const stackDigest = "4".repeat(64);
const teardownDigest = "5".repeat(64);
const planDigest = "6".repeat(64);
const projectName = "craig-e2e-1234567890abcdef1234";
function cleanupContent(root: string) {
  return { campaignId: "campaign-1", campaignRoot: root, deleted: true as const, device: 7,
    hostedPlanSha256: planDigest, inode: 8, kind: "campaign-lease-cleanup" as const,
    leasePath: join(root, "barriers/campaign.lease"), leaseReceiptSha256: leaseReceiptDigest,
    leaseSha256: leaseDigest, passReceiptSha256: passDigest, projectName, schemaVersion: 1 as const,
    stackReceiptSha256: stackDigest, teardownReceiptSha256: teardownDigest };
}
async function verifyCleanup(root: string) {
  return verifyCampaignLeaseCleanupReceipt(root,
    { campaignId: "campaign-1", receiptSha256: passDigest } as never,
    { projectName, receiptSha256: stackDigest } as never,
    { campaignRoot: root, device: 7, hostedPlanSha256: planDigest, inode: 8,
      leaseSha256: leaseDigest, receiptSha256: leaseReceiptDigest },
    { receiptSha256: teardownDigest });
}
