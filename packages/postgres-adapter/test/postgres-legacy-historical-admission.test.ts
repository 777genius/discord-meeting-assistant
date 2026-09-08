import { describe, expect, it } from "vitest";
import { PinnedLegacyHistoricalReceiptVerifier } from "../src/postgres-legacy-historical-verifier.js";
import { resolveAcceptedHistoricalMeeting } from "../src/postgres-accepted-historical-meeting.js";
import { loadPostgresMigrations, requiredPostgresSchemaVersion } from "../src/postgres-migrations.js";
import { legacyFixture } from "./legacy-historical-fixture.js";

describe("pinned legacy trust and local resolution", () => {
  it("registers immutable receipt persistence as schema migration 44", async () => {
    const migrations = await loadPostgresMigrations();
    expect(requiredPostgresSchemaVersion).toBe(44);
    expect(migrations.at(-1)).toMatchObject({ fileName: "0044_legacy_historical_admissions.sql", version: 44 });
  });
  it("verifies authentic synthetic Ed25519 bytes and denies absent or changed trust", () => {
    const f = legacyFixture();
    const verifier = new PinnedLegacyHistoricalReceiptVerifier(f.trust);
    expect(verifier.verify(f.signed()).payload).toEqual(f.payload);
    expect(() => new PinnedLegacyHistoricalReceiptVerifier([]).verify(f.signed())).toThrow();
    expect(() => verifier.verify({ ...f.signed(), signature: `${"A".repeat(86)}==` })).toThrow();
    expect(() => verifier.verify(f.signed({ ...f.payload, policyId: "diagnostic" }))).toThrow();
    expect(() => verifier.verify(f.signed({ ...f.payload, signerId: "someone-else" }))).toThrow();
  });
  it.each(["signerId", "snapshotSha256", "transcriptSha256", "recordingId", "savedSourceSha256",
    "identityEvidenceSha256", "scopeRoomEvidenceSha256", "durationEvidenceSha256"] as const)(
    "rejects independent unsigned %s tamper", (field) => {
      const f = legacyFixture();
      const verifier = new PinnedLegacyHistoricalReceiptVerifier(f.trust);
      const receipt = { ...f.signed(), payload: { ...f.payload, [field]: "a".repeat(64) } };
      expect(() => verifier.verify(receipt)).toThrow();
      expect(resolveAcceptedHistoricalMeeting({ binding: f.binding, snapshot: f.snapshot,
        revision: f.snapshot.revision, receipt, verifier })).toBeNull();
    });
  it("rejects unsigned actor, source, duration and complete release tamper", () => {
    const f = legacyFixture(); const verifier = new PinnedLegacyHistoricalReceiptVerifier(f.trust);
    for (const change of [{ actors: [{ actorId: "impostor", kind: "human" }] },
      { authoritativeDurationMs: 20_000 }, { binding: { ...f.binding, roomId: "wrong" } },
      { binding: { ...f.binding, scopeId: "wrong" } },
      { binding: { ...f.binding, desiredGeneration: 2 } }]) {
      expect(() => verifier.verify({ ...f.signed(), payload: { ...f.payload, ...change } })).toThrow();
    }
    expect(resolveAcceptedHistoricalMeeting({ binding: { ...f.binding, roomId: "wrong" },
      snapshot: f.snapshot, revision: f.snapshot.revision, receipt: f.signed(), verifier })).toBeNull();
  });
  it("rehydrates only an exact snapshot/revision and keeps lifecycle metadata absent", () => {
    const f = legacyFixture(); const verifier = new PinnedLegacyHistoricalReceiptVerifier(f.trust);
    const resolve = (snapshot: unknown = f.snapshot, revision = f.snapshot.revision, receipt: unknown = f.signed()) =>
      resolveAcceptedHistoricalMeeting({ binding: f.binding, revision, snapshot, receipt, verifier });
    expect(resolve()?.admission).toBe("signed_legacy_v1");
    expect(resolve()?.humanTurns).toHaveLength(f.snapshot.transcript!.turns.length);
    expect(resolve(f.snapshot, f.snapshot.revision + 1)).toBeNull();
    expect(resolve({ ...f.snapshot, publicationTargetId: "mutated" })).toBeNull();
    expect(resolve({ ...f.snapshot, transcript: { ...f.snapshot.transcript, version: 2 } })).toBeNull();
    expect(resolve(f.snapshot, f.snapshot.revision, null)).toBeNull();
    expect(resolveAcceptedHistoricalMeeting({ binding: f.binding, revision: f.snapshot.revision,
      snapshot: f.snapshot, receipt: f.signed() })).toBeNull();
  });
  it("cannot override canonical identity even with a new authentic signature", () => {
    const f = legacyFixture(); const verifier = new PinnedLegacyHistoricalReceiptVerifier(f.trust);
    for (const change of [{ source: { scopeId: "wrong", roomId: "wrong" } },
      { lifecycleGeneration: 3 }, { actors: [{ actorId: "wrong", kind: "human" }] },
      { recording: { ...f.snapshot.recording, authoritativeDurationMs: 123 } }]) {
      const snapshot = { ...f.snapshot, ...change };
      const receipt = f.signed({ ...f.payload, snapshotSha256: f.sha(f.canonical(snapshot)) });
      expect(resolveAcceptedHistoricalMeeting({ binding: f.binding, revision: snapshot.revision,
        snapshot, receipt, verifier })).toBeNull();
    }
  });
  it("binds absent legacy metadata to raw stored bytes before restore defaults", () => {
    const f = legacyFixture(); const verifier = new PinnedLegacyHistoricalReceiptVerifier(f.trust);
    const snapshot: Record<string, unknown> = { ...f.snapshot };
    for (const key of ["source", "actors", "identityProvenance", "lifecycleGeneration"]) {
      delete snapshot[key];
    }
    const receipt = f.signed({ ...f.payload, snapshotSha256: f.sha(f.canonical(snapshot)) });
    const input = { binding: f.binding, revision: f.snapshot.revision, receipt, verifier };
    expect(resolveAcceptedHistoricalMeeting({ ...input, snapshot })?.admission).toBe("signed_legacy_v1");
    // Null and absent restore alike, but a receipt cannot authorize rewritten source bytes.
    expect(resolveAcceptedHistoricalMeeting({ ...input, snapshot: f.snapshot })).toBeNull();
    expect(snapshot).not.toHaveProperty("source");
  });
});
