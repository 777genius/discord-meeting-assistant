import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HistoricalSyncWorker, createHistoricalReleaseBinding,
  type HistoricalMemoryPort, type LegacyHistoricalPayloadV1 } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { acceptLegacyHistoricalAdmission, PinnedLegacyHistoricalReceiptVerifier,
  PostgresHistoricalEvidenceAuthority, PostgresHistoricalMemoryStore,
  PostgresHistoricalRoomAuthoritySnapshot, PostgresSchemaReadiness } from "../src/index.js";
import { requestAnswerSourceWithdrawal } from "../src/postgres-answer-source-withdrawal.js";
import { withHistoricalPostgresTransaction } from "../src/postgres-historical-query.js";
import { databaseOrSkip, usePostgresIntegrationDatabase } from "./postgres-integration-fixtures.js";
import { legacyFixture } from "./legacy-historical-fixture.js";

usePostgresIntegrationDatabase();
async function setup(pool: ReturnType<typeof databaseOrSkip>) {
  const f = legacyFixture(); const verifier = new PinnedLegacyHistoricalReceiptVerifier(f.trust);
  await pool.query(`INSERT INTO meeting_core.meetings (meeting_id, revision, snapshot)
    VALUES ($1, $2, $3)`, [f.snapshot.meetingId, f.snapshot.revision, f.snapshot]);
  const accept = (payload: LegacyHistoricalPayloadV1 = f.payload, savedSourceJson = f.savedSourceJson) =>
    acceptLegacyHistoricalAdmission({ pool, verifier, receipt: f.signed(payload), savedSourceJson });
  return { ...f, accept, verifier };
}
const ids = { keyedId: (namespace: string, parts: readonly string[]) =>
  createHash("sha256").update(JSON.stringify([namespace, parts])).digest("hex") };
const memory: HistoricalMemoryPort = {
  indexFinalMeeting: async (plan) => ({ status: "applied", remoteDocumentIds:
    Object.fromEntries(plan.documents.map((document) =>
      [document.manifest.documentExternalId, `remote-${document.manifest.documentExternalId}`])) }),
  deleteMeeting: async () => ({ status: "verified_absent" }),
};

describe("legacy PostgreSQL transaction and historical worker", () => {
  it("atomically enqueues pending work, serializes identical replay, and retains immutable bytes", async (context) => {
    const pool = databaseOrSkip(context); const f = await setup(pool);
    expect((await Promise.all([f.accept(), f.accept()])).toSorted()).toEqual(["accepted", "replayed"]);
    expect((await pool.query("SELECT state, plan FROM meeting_core.historical_memory_sync")).rows)
      .toEqual([{ state: "pending", plan: null }]);
    await expect(f.accept({ ...f.payload, identityEvidenceSha256: "a".repeat(64) })).rejects.toThrow("conflicts");
    await expect(pool.query("UPDATE meeting_core.legacy_historical_admissions SET receipt_json = '{}'"))
      .rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM meeting_core.legacy_historical_admissions")).rejects.toThrow("immutable");
    await new PostgresSchemaReadiness(pool).assertReady();
    await pool.query("ALTER TABLE meeting_core.legacy_historical_admissions DISABLE TRIGGER legacy_historical_admissions_immutable");
    try { await expect(new PostgresSchemaReadiness(pool).assertReady()).rejects.toThrow("trigger"); }
    finally { await pool.query("ALTER TABLE meeting_core.legacy_historical_admissions ENABLE TRIGGER legacy_historical_admissions_immutable"); }
  });
  it("rolls receipt insertion back when generation acceptance fails", async (context) => {
    const pool = databaseOrSkip(context); const f = await setup(pool);
    await expect(f.accept({ ...f.payload, binding: { ...f.binding, desiredGeneration: 2 } }))
      .rejects.toThrow("monotonic");
    expect((await pool.query("SELECT * FROM meeting_core.legacy_historical_admissions")).rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM meeting_core.historical_memory_sync")).rowCount).toBe(0);
  });
  it("denies independent signed binding/source tamper before enqueue", async (context) => {
    const pool = databaseOrSkip(context); const f = await setup(pool);
    for (const change of [{ snapshotSha256: "a".repeat(64) }, { transcriptSha256: "a".repeat(64) },
      { recordingId: "wrong" }, { actors: [] }, { authoritativeDurationMs: 1 },
      { binding: { ...f.binding, acceptedMeetingRevision: f.snapshot.revision + 1 } }]) {
      await expect(f.accept({ ...f.payload, ...change })).rejects.toThrow();
    }
    await expect(f.accept(f.payload, "{}")).rejects.toThrow("saved source");
    expect((await pool.query("SELECT * FROM meeting_core.historical_memory_sync")).rowCount).toBe(0);
  });
  it("serializes conflicting concurrent receipts with exactly one accepted declaration", async (context) => {
    const pool = databaseOrSkip(context); const f = await setup(pool);
    const results = await Promise.allSettled([f.accept(),
      f.accept({ ...f.payload, durationEvidenceSha256: "a".repeat(64) })]);
    expect(results.map(({ status }) => status).toSorted()).toEqual(["fulfilled", "rejected"]);
    expect((await pool.query("SELECT * FROM meeting_core.legacy_historical_admissions")).rowCount).toBe(1);
  });
  it("requires current applied worker plans, survives restart, and isolates changed candidates", async (context) => {
    const pool = databaseOrSkip(context); const f = await setup(pool); await f.accept();
    const store = new PostgresHistoricalMemoryStore(pool);
    const authority = new PostgresHistoricalEvidenceAuthority(pool, undefined, f.verifier);
    const room = () => new PostgresHistoricalRoomAuthoritySnapshot(pool, undefined, f.verifier)
      .loadRoomAuthoritySnapshot({ scopeId: f.binding.scopeId, roomId: f.binding.roomId,
        maximumSources: 10, pageSize: 1 });
    expect(await room()).toMatchObject({ status: "current", entries: [] });
    const worker = () => new HistoricalSyncWorker({ authority, store, ids, memory });
    expect(await worker().executeOnce({ indexingEnabled: true })).toMatchObject({ status: "applied" });
    const applied = await room();
    expect(applied).toMatchObject({ status: "current", entries: [{ acceptedMeeting: { admission: "signed_legacy_v1" } }] });
    expect(await f.accept()).toBe("replayed");
    expect(await worker().executeOnce({ indexingEnabled: true })).toEqual({ status: "idle" });
    expect(await room()).toEqual(applied);
    await pool.query("UPDATE meeting_core.meetings SET snapshot = jsonb_set(snapshot, '{publicationTargetId}', '\"mutated\"')");
    expect(await authority.loadAcceptedFinalMeeting(f.binding)).toBeNull();
    expect(await room()).toMatchObject({ status: "current", entries: [{ acceptedMeeting: null }] });
  });
  it("keeps unknown and rejected indexing out of the room", async (context) => {
    const pool = databaseOrSkip(context); const f = await setup(pool); await f.accept();
    const store = new PostgresHistoricalMemoryStore(pool);
    const authority = new PostgresHistoricalEvidenceAuthority(pool, undefined, f.verifier);
    const unknown: HistoricalMemoryPort = { ...memory,
      indexFinalMeeting: async () => ({ status: "outcome_unknown", retryable: true, code: "synthetic" }) };
    expect(await new HistoricalSyncWorker({ authority, store, ids, memory: unknown })
      .executeOnce({ indexingEnabled: true })).toMatchObject({ status: "retry_scheduled" });
    expect(await new PostgresHistoricalRoomAuthoritySnapshot(pool, undefined, f.verifier)
      .loadRoomAuthoritySnapshot({ scopeId: f.binding.scopeId, roomId: f.binding.roomId,
        maximumSources: 10, pageSize: 1 })).toMatchObject({ entries: [] });
  });
  it("supersedes monotonically and denies stale rehydration and withdrawal replay", async (context) => {
    const pool = databaseOrSkip(context); const f = await setup(pool); await f.accept();
    const snapshot = { ...f.snapshot, revision: f.snapshot.revision + 1,
      transcript: { ...f.snapshot.transcript!, version: f.binding.transcriptVersion + 1 } };
    const binding = createHistoricalReleaseBinding({ ...f.binding, acceptedMeetingRevision: snapshot.revision,
      desiredGeneration: 2, transcriptVersion: snapshot.transcript.version });
    await pool.query("UPDATE meeting_core.meetings SET revision = $1, snapshot = $2", [snapshot.revision, snapshot]);
    const source = f.canonical(snapshot.transcript);
    await f.accept({ ...f.payload, binding, snapshotSha256: f.sha(f.canonical(snapshot)),
      transcriptSha256: f.sha(source), savedSourceSha256: f.sha(source) }, source);
    const authority = new PostgresHistoricalEvidenceAuthority(pool, undefined, f.verifier);
    expect(await authority.loadAcceptedFinalMeeting(f.binding)).toBeNull();
    expect(await authority.loadAcceptedFinalMeeting(binding)).not.toBeNull();
    expect((await pool.query("SELECT desired_generation::int, is_current FROM meeting_core.historical_memory_sync ORDER BY desired_generation")).rows)
      .toEqual([{ desired_generation: 1, is_current: false }, { desired_generation: 2, is_current: true }]);
    await withHistoricalPostgresTransaction(pool, undefined,
      (client) => requestAnswerSourceWithdrawal(client, binding.meetingId));
    expect(await authority.loadAcceptedFinalMeeting(binding)).toBeNull();
    await expect(f.accept({ ...f.payload, binding, snapshotSha256: f.sha(f.canonical(snapshot)),
      transcriptSha256: f.sha(source), savedSourceSha256: f.sha(source) }, source)).rejects.toThrow("withdrawn");
  });
});
