import { describe, expect, it } from "vitest";

import { sha256 } from "../src/quality-campaign/canonical.js";
import { createOperatorSafeReceipt } from "../src/quality-campaign/operator-cli.js";
import { retentionCheckpointReceipt } from
  "../src/quality-campaign/production-checkpoints.js";

describe("quality campaign retention checkpoint", () => {
  const campaignRootSha256 = sha256("campaign-root");
  const inventorySha256 = sha256("inventory");
  const localCanonicalInventorySha256 = sha256("local-canonical-inventory");

  it.each([1, 2, 3] as const)(
    "binds repetition %i metrics into the receipt/checkpoint without exposing them", (repetition) => {
      const metricsSha256ByRepetition = { 1: sha256("metrics-1"),
        2: sha256("metrics-2"), 3: sha256("metrics-3") };
      const receipt = retentionCheckpointReceipt(campaignRootSha256, {
        inventorySha256, metricsSha256ByRepetition }, localCanonicalInventorySha256);
      const changed = retentionCheckpointReceipt(campaignRootSha256, { inventorySha256,
        metricsSha256ByRepetition: { ...metricsSha256ByRepetition,
          [repetition]: sha256(`changed-metrics-${repetition}`) } },
      localCanonicalInventorySha256);

      expect(receipt).toEqual({ counters: { outcomeCount: 720 }, digests: {
        campaignRootSha256, inventorySha256, localCanonicalInventorySha256, metricsSha256:
          sha256(metricsSha256ByRepetition) }, errorCode: null });
      expect(sha256(changed)).not.toBe(sha256(receipt));
      expect(JSON.stringify(receipt)).not.toContain(metricsSha256ByRepetition[1]);
      expect(receipt).not.toHaveProperty("metricsSha256ByRepetition");
    });

  it("canonicalizes repetition-key order and does not upgrade an old unbound receipt", () => {
    const ordered = retentionCheckpointReceipt(campaignRootSha256, { inventorySha256,
      metricsSha256ByRepetition: { 1: sha256("one"), 2: sha256("two"), 3: sha256("three") } },
    localCanonicalInventorySha256);
    const reordered = retentionCheckpointReceipt(campaignRootSha256, { inventorySha256,
      metricsSha256ByRepetition: { 3: sha256("three"), 1: sha256("one"), 2: sha256("two") } },
    localCanonicalInventorySha256);
    const oldReceipt = createOperatorSafeReceipt(campaignRootSha256,
      { inventorySha256, outcomeCount: 720 });

    expect(reordered).toEqual(ordered);
    expect(sha256(oldReceipt)).not.toBe(sha256(ordered));
    expect(oldReceipt.digests).not.toHaveProperty("metricsSha256");
    expect(sha256(retentionCheckpointReceipt(campaignRootSha256, { inventorySha256,
      metricsSha256ByRepetition: { 1: sha256("one"), 2: sha256("two"), 3: sha256("three") } },
    sha256("changed-local-inventory")))).not.toBe(sha256(ordered));
  });
});
