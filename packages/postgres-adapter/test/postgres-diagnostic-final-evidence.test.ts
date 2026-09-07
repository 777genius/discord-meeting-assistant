import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { canonicalHistoricalPlannerJson, createHistoricalReleaseBinding } from "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresDiagnosticFinalEvidence, assertConstructedPostgresDiagnosticFinalEvidence, assertConstructedPostgresHistoricalEvidenceAuthority } from "../src/index.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalHistoricalPlannerJson(value)).digest("hex");
const turn = (speakerId: string, index: number) => ({ speakerId, turnId: `turn-${index}`, text: "Synthetic evidence", startMs: index * 100, endMs: index * 100 + 90 });
function fixture() {
  const snapshot = { meetingId: "synthetic-meeting", revision: 7, transcriptionStage: { status: "succeeded" }, transcript: { transcriptId: "synthetic-transcript", recordingId: "synthetic-recording", version: 2, turns: [turn("human", 0), turn("bot", 1)] } };
  const binding = { meetingId: snapshot.meetingId, snapshotSha256: hash(snapshot), transcriptSha256: hash(snapshot.transcript), transcriptVersion: 2, roster: { humans: ["human"], automation: ["bot"] }, scopeId: "diagnostic:scope", roomId: "diagnostic:room", releaseId: createHistoricalReleaseBinding({ meetingId: snapshot.meetingId, transcriptId: snapshot.transcript.transcriptId, transcriptVersion: 2, acceptedMeetingRevision: 7, desiredGeneration: 1, scopeId: "diagnostic:scope", roomId: "diagnostic:room" }).releaseId };
  const queries: string[] = [];
  const pool = { query: async (sql: string) => { queries.push(sql); return { rows: [{ revision: snapshot.revision, snapshot }] }; } } as unknown as Pool;
  return { snapshot, binding, queries, pool };
}
import { databaseOrSkip, usePostgresIntegrationDatabase } from "./postgres-integration-fixtures.js";
usePostgresIntegrationDatabase();
describe("nonqualifying diagnostic final evidence", () => {
  it("reads legacy final evidence, excludes automation, and never writes", async () => {
    const f = fixture();
    const adapter = new PostgresDiagnosticFinalEvidence(f.pool, f.binding);
    const projection = await adapter.loadFrozenProjection();
    expect(projection.humanTurns.map((item) => item.speakerId)).toEqual(["human"]);
    expect(projection.authoritativeDurationMs).toBeNull();
    expect(projection).not.toHaveProperty("lifecycleGeneration");
    expect(await adapter.loadAcceptedFinalMeeting(projection.binding)).toEqual(projection);
    expect(await adapter.loadAcceptedFinalMeeting({ ...projection.binding, roomId: "diagnostic:foreign" })).toBeNull();
    expect(f.queries).toHaveLength(3);
    expect(f.queries.every((sql) => sql.startsWith("SELECT ") && !/INSERT|UPDATE|DELETE/u.test(sql))).toBe(true);
  });
  it("keeps immutable constructor inputs and rejects forged/production authority", async () => {
    const f = fixture(); const adapter = new PostgresDiagnosticFinalEvidence(f.pool, f.binding);
    f.binding.roster.humans.push("bot"); f.binding.meetingId = "foreign";
    expect((await adapter.loadFrozenProjection()).humanTurns).toHaveLength(1);
    expect(() => { assertConstructedPostgresDiagnosticFinalEvidence(adapter); }).not.toThrow();
    expect(() => { assertConstructedPostgresDiagnosticFinalEvidence(Object.create(PostgresDiagnosticFinalEvidence.prototype)); }).toThrow();
    expect(() => { assertConstructedPostgresHistoricalEvidenceAuthority(adapter); }).toThrow();
  });
  it("detects drift on every load", async () => {
    const f = fixture(); const adapter = new PostgresDiagnosticFinalEvidence(f.pool, f.binding);
    await adapter.loadFrozenProjection(); f.snapshot.transcript.turns[0]!.text = "Changed synthetic text";
    await expect(adapter.loadFrozenProjection()).rejects.toThrow("changed");
  });
  it.each(["meetingId", "transcriptVersion", "snapshotSha256", "transcriptSha256"] as const)("rejects foreign %s", async (field) => {
    const f = fixture(); const binding = { ...f.binding, [field]: field === "transcriptVersion" ? 3 : field.endsWith("Sha256") ? "0".repeat(64) : "foreign" };
    await expect(new PostgresDiagnosticFinalEvidence(f.pool, binding).loadFrozenProjection()).rejects.toThrow();
  });
  it("rejects namespaces and overlapping rosters", () => {
    const f = fixture();
    expect(() => new PostgresDiagnosticFinalEvidence(f.pool, { ...f.binding, scopeId: "production" })).toThrow();
    expect(() => new PostgresDiagnosticFinalEvidence(f.pool, { ...f.binding, roster: { humans: ["human"], automation: ["human"] } })).toThrow();
  });
});

it("reads synthetic legacy JSONB using disposable PostgreSQL and rejects drift", async (context) => {
  const database = databaseOrSkip(context);
  const f = fixture();
  await database.query("INSERT INTO meeting_core.meetings (meeting_id, revision, snapshot) VALUES ($1, $2, $3::jsonb)", [f.snapshot.meetingId, f.snapshot.revision, JSON.stringify(f.snapshot)]);
  const adapter = new PostgresDiagnosticFinalEvidence(database, f.binding);
  expect((await adapter.loadFrozenProjection()).humanTurns).toHaveLength(1);
  await database.query("UPDATE meeting_core.meetings SET snapshot = jsonb_set(snapshot, '{transcript,version}', '3') WHERE meeting_id = $1", [f.snapshot.meetingId]);
  await expect(adapter.loadFrozenProjection()).rejects.toThrow("changed");
});
it("rejects unknown transcript speakers even with matching snapshot hashes", async () => {
  const f = fixture();
  const binding = { ...f.binding, roster: { humans: ["human"], automation: [] } };
  await expect(new PostgresDiagnosticFinalEvidence(f.pool, binding).loadFrozenProjection()).rejects.toThrow();
});
