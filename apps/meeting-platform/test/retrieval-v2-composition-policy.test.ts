import { describe, expect, it } from "vitest";

import { localFinalReplyPolicy } from
  "../src/composition/meeting-knowledge.js";

describe("Retrieval V2 composition policy", () => {
  it("keeps V2 serving at zero and the old engine migration-only", () => {
    expect(localFinalReplyPolicy.retrievalAdmission.infinityRolloutBasisPoints)
      .toBe(0);
    expect(localFinalReplyPolicy.retrievalAdmission.retrievalV2ProviderBinding)
      .toBeUndefined();
    expect(localFinalReplyPolicy.legacyRetrievalMigration).toEqual({
      deleteAfter: "2026-10-31",
      enabled: true,
      minimumQualifiedReleases: 2,
      requireDrainedJobs: true,
      requireNoUnresolvedEffects: true,
    });
  });
});
