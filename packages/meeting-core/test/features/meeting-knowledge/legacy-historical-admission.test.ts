import { describe, expect, it } from "vitest";
import { admitLegacyAcceptedFinalMeeting, createHistoricalReleaseBinding,
  decodeSignedLegacyHistoricalReceipt, legacyHistoricalCanonicalJson,
  type SignedLegacyHistoricalReceiptV1 } from "@discord-meeting/meeting-core/meeting-knowledge";

function receipt(): SignedLegacyHistoricalReceiptV1 {
  return { signature: `${"A".repeat(86)}==`, payload: {
    admission: "signed_legacy_v1", policyVersion: 1, policyId: "synthetic-policy", signerId: "synthetic-signer",
    binding: createHistoricalReleaseBinding({ acceptedMeetingRevision: 2, desiredGeneration: 1,
      meetingId: "m", roomId: "r", scopeId: "s", transcriptId: "t", transcriptVersion: 2 }),
    recordingId: "recording", snapshotSha256: "a".repeat(64), transcriptSha256: "b".repeat(64),
    savedSourceSha256: "c".repeat(64), identityEvidenceSha256: "d".repeat(64),
    scopeRoomEvidenceSha256: "e".repeat(64), durationEvidenceSha256: "f".repeat(64),
    authoritativeDurationMs: 2_000, actors: [{ actorId: "person", kind: "human" },
      { actorId: "assistant", kind: "automation" }],
  } };
}
const turns = [
  { turnId: "a", speakerId: "person", startMs: 0, endMs: 1_000, text: "Human evidence" },
  { turnId: "b", speakerId: "assistant", startMs: 1_000, endMs: 2_000, text: "Automation" },
];
describe("bounded legacy domain admission", () => {
  it("selects only declared humans without mutating or forging lifecycle provenance", () => {
    const verified = decodeSignedLegacyHistoricalReceipt(receipt());
    const accepted = admitLegacyAcceptedFinalMeeting({ verifiedPayload: verified.payload, turns });
    expect(accepted?.admission).toBe("signed_legacy_v1");
    expect(accepted?.humanTurns).toEqual([turns[0]]);
    expect(accepted).not.toHaveProperty("identityProvenance");
    expect(turns).toHaveLength(2);
    expect(Object.isFrozen(verified.payload.actors)).toBe(true);
  });
  it("pins key order and exact array order in canonical JSON", () => {
    expect(legacyHistoricalCanonicalJson({ z: [2, 1], a: "é\n" })).toBe('{"a":"é\\n","z":[2,1]}');
    expect(legacyHistoricalCanonicalJson(null)).toBe("null");
    expect(() => legacyHistoricalCanonicalJson({ a: undefined })).toThrow();
  });
  it.each([
    { admission: "diagnostic" }, { policyVersion: 2 }, { extra: true },
    { policyId: "synthetic\u0000policy" },
    { snapshotSha256: "invalid" }, { authoritativeDurationMs: 0 },
    { actors: [{ actorId: "person", kind: "unknown" }] },
    { actors: [{ actorId: "person", kind: "human" }, { actorId: "person", kind: "human" }] },
    { actors: [{ actorId: "person", kind: "human" }, { actorId: "person", kind: "automation" }] },
  ])("rejects invalid declarations %j", (change) => {
    const candidate = receipt();
    expect(() => decodeSignedLegacyHistoricalReceipt({ ...candidate,
      payload: { ...candidate.payload, ...change } })).toThrow();
  });
  it("rejects unsigned and open nested contracts", () => {
    const candidate = receipt();
    expect(() => decodeSignedLegacyHistoricalReceipt({ payload: candidate.payload })).toThrow();
    expect(() => decodeSignedLegacyHistoricalReceipt({ ...candidate, payload: {
      ...candidate.payload, binding: { ...candidate.payload.binding, extra: true } } })).toThrow();
  });
  it.each([
    [{ ...turns[0]!, speakerId: "uncovered" }],
    [{ ...turns[0]!, endMs: 2_001 }], [{ ...turns[0]!, startMs: -1 }],
    [{ ...turns[0]!, endMs: 0 }], [turns[0]!, turns[0]!],
    [turns[0]!, { ...turns[1]!, endMs: 2_001 }],
  ])("rejects incomplete speakers or invalid timing/turn identity", (...invalidTurns) => {
    expect(() => admitLegacyAcceptedFinalMeeting({ verifiedPayload: receipt().payload,
      turns: invalidTurns })).toThrow();
  });
});
