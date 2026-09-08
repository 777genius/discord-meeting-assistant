import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { admitLegacyAcceptedFinalMeeting, buildHistoricalIndexPlan } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresHistoricalEvidenceAuthority, PostgresHistoricalRoomAuthoritySnapshot } from
  "../src/postgres-historical-evidence-authority.js";
import { PinnedLegacyHistoricalReceiptVerifier } from "../src/postgres-legacy-historical-verifier.js";
import { legacyFixture } from "./legacy-historical-fixture.js";

function appliedRow(f: ReturnType<typeof legacyFixture>) {
  const meeting = admitLegacyAcceptedFinalMeeting({ verifiedPayload: f.payload, turns: f.snapshot.transcript!.turns })!;
  const plan = buildHistoricalIndexPlan(meeting, { keyedId: (namespace, parts) =>
    createHash("sha256").update(JSON.stringify([namespace, parts])).digest("hex") });
  return { accepted_meeting_revision: f.binding.acceptedMeetingRevision, applied_index_profile_id: "synthetic-profile",
    attempt_count: 1, desired_generation: f.binding.desiredGeneration, evidence_policy_version: f.binding.evidencePolicyVersion,
    lease_fence: 1, meeting_id: f.binding.meetingId, operation: "index", plan, profile_rebuild_requested: false,
    release_id: f.binding.releaseId, remote_document_ids: {}, room_id: f.binding.roomId, schema_version: 1,
    scope_id: f.binding.scopeId, transcript_id: f.binding.transcriptId, transcript_version: f.binding.transcriptVersion,
    meeting_revision: f.snapshot.revision, meeting_snapshot: f.snapshot, legacy_receipt: f.signed(), withdrawn: false };
}

/** A protocol fake tests adapter pagination/isolation, not PostgreSQL isolation semantics. */
function roomPool(rows: readonly ReturnType<typeof appliedRow>[], count = rows.length) {
  const commands: string[] = [];
  const client = { release: () => {}, query: async (text: string, values?: readonly unknown[]) => {
    commands.push(text);
    if (text.includes("count(*)")) { return { rows: [{ count }] }; }
    if (text.includes("SELECT historical.*")) {
      const cursor = values?.[2] as string; const pageSize = values?.[3] as number;
      return { rows: rows.filter((row) => row.release_id > cursor).slice(0, pageSize) };
    }
    return { rows: [] };
  } };
  return { commands, pool: { connect: async () => client } as unknown as Pool };
}

describe("legacy receipt room/current read protocol", () => {
  it("uses one repeatable-read snapshot with pagination and isolated invalid candidates", async () => {
    const a = legacyFixture("a"); const b = legacyFixture("b");
    const verifier = new PinnedLegacyHistoricalReceiptVerifier([...a.trust,
      { ...b.trust[0]!, signerId: "second-signer" }]);
    const secondPayload = { ...b.payload, signerId: "second-signer" };
    const rowB = { ...appliedRow(b), legacy_receipt: b.signed(secondPayload),
      meeting_snapshot: { ...b.snapshot, publicationTargetId: "changed" } };
    const db = roomPool([appliedRow(a), rowB]);
    const result = await new PostgresHistoricalRoomAuthoritySnapshot(db.pool, undefined, verifier)
      .loadRoomAuthoritySnapshot({ scopeId: a.binding.scopeId, roomId: a.binding.roomId,
        maximumSources: 2, pageSize: 1 });
    expect(result).toMatchObject({ status: "current", entries: [
      { acceptedMeeting: { admission: "signed_legacy_v1" } }, { acceptedMeeting: null }] });
    expect(db.commands[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(db.commands.filter((command) => command.includes("SELECT historical.*"))).toHaveLength(3);
    expect(db.commands.at(-1)).toBe("COMMIT");
  });
  it("fails closed on overflow or inconsistent count", async () => {
    const f = legacyFixture(); const row = appliedRow(f);
    const verifier = new PinnedLegacyHistoricalReceiptVerifier(f.trust);
    const load = (db: ReturnType<typeof roomPool>, maximumSources: number) =>
      new PostgresHistoricalRoomAuthoritySnapshot(db.pool, undefined, verifier).loadRoomAuthoritySnapshot({
        scopeId: f.binding.scopeId, roomId: f.binding.roomId, maximumSources, pageSize: 2 });
    expect(await load(roomPool([row, row]), 1)).toEqual({ schemaVersion: 1, status: "overflow" });
    expect(await load(roomPool([row], 2), 2)).toEqual({ schemaVersion: 1, status: "unavailable" });
  });
  it("rehydrates only a current nonwithdrawn signed release with current public trust", async () => {
    const f = legacyFixture(); const verifier = new PinnedLegacyHistoricalReceiptVerifier(f.trust);
    const row = { snapshot: f.snapshot, revision: f.snapshot.revision, legacy_receipt: f.signed(),
      legacy_current: true, withdrawn: false };
    const load = (change: Record<string, unknown> = {}, trust = verifier) => {
      const pool = { query: async () => ({ rows: [{ ...row, ...change }] }) } as unknown as Pool;
      return new PostgresHistoricalEvidenceAuthority(pool, undefined, trust).loadAcceptedFinalMeeting(f.binding);
    };
    expect(await load()).toMatchObject({ admission: "signed_legacy_v1" });
    expect(await load({ legacy_current: false })).toBeNull();
    expect(await load({ withdrawn: true })).toBeNull();
    expect(await load({}, new PinnedLegacyHistoricalReceiptVerifier([]))).toBeNull();
  });
});
