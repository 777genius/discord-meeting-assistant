import { describe, expect, it } from "vitest";

import { validateCanonicalScopeResolutionObservation } from
  "../src/quality-campaign/canonical-metadata-contract.js";

const read = { kind: "scope_spaces", requestSha256: "a".repeat(64),
  responseSha256: "b".repeat(64), responseBytes: 12, status: "received" };
const observation = { schemaVersion: "meeting_knowledge.scope_resolution.v1", status: "prepared",
  reads: [read, { ...read, kind: "scope_memory_scopes" }] };

describe("consumer-owned canonical metadata schema", () => {
  it("retains exact digests and freezes the validated observation", () => {
    const result = validateCanonicalScopeResolutionObservation(observation);
    expect(result).toEqual(observation);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reads)).toBe(true);
    expect(result.reads.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    null, { ...observation, extra: true }, { reads: observation.reads, status: "prepared" },
    { ...observation, status: "unknown" }, { ...observation, reads: [] },
    { ...observation, reads: [read] }, { ...observation, reads: [read, read] },
    { ...observation, reads: [...observation.reads, read] },
    { ...observation, reads: [{ ...read, responseBytes: 65_537 }, observation.reads[1]] },
    { ...observation, reads: [{ ...read, requestSha256: "invalid" }, observation.reads[1]] },
    { ...observation, reads: [{ ...read, extra: true }, observation.reads[1]] },
    { ...observation, reads: [{ ...read, status: "outcome_unknown", responseSha256: null,
      responseBytes: 0 }, observation.reads[1]] },
  ])("rejects malformed or incomplete metadata %#", (value) => {
    expect(() => validateCanonicalScopeResolutionObservation(value)).toThrow();
  });

  it("preserves unknown outcomes without inventing response evidence", () => {
    const unknown = { ...observation, status: "interrupted", reads: [{ ...read,
      status: "outcome_unknown", responseSha256: null, responseBytes: 0 }] };
    expect(validateCanonicalScopeResolutionObservation(unknown)).toEqual(unknown);
    for (const response of [{ responseSha256: read.responseSha256, responseBytes: 0 },
      { responseSha256: null, responseBytes: 1 }]) {
      expect(() => validateCanonicalScopeResolutionObservation({ ...unknown,
        reads: [{ ...unknown.reads[0], ...response }] })).toThrow();
    }
  });
});
