import { LiveFinalizedMemoryWorker } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { LiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { describe, expect, it } from "vitest";

import {
  PostgresLiveFinalizedMemoryLifecycle,
  PostgresLiveFinalizedMemoryStore,
  PostgresLiveMeetingRepository,
  canonicalFinalReplyTurnHash,
} from "../src/index.js";
import { retireLiveFinalizedMemoryGeneration } from
  "../src/postgres-live-memory-retirement.js";
import {
  databaseOrSkip,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

usePostgresIntegrationDatabase();

describe("PostgreSQL live memory retirement", () => {
  it("atomically supersedes the live generation and drains stable documents", async (context) => {
    const database = databaseOrSkip(context);
    const meetingId = "live-memory-retirement-1";
    const repository = new PostgresLiveMeetingRepository(database);
    await repository.save(LiveMeeting.start({
      meetingId,
      publicationTargetId: "channel-1",
      startedAtMs: 0,
    }).toSnapshot(), null);
    const lifecycle = new PostgresLiveFinalizedMemoryLifecycle(database);
    await lifecycle.registerMeeting({
      actors: [{ actorId: "human-1", kind: "human" }],
      identityProvenance: {
        actorObservationState: "consistent",
        actorSemanticsVersion: 1,
        producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
        producerRevision: "producer-r1",
        rosterState: "unsealed",
      },
      lifecycleGeneration: 3,
      meetingId,
      roomId: "room-1",
      scopeId: "scope-1",
    });
    await repository.appendFinalizedTurn(meetingId, {
      endMs: 2_000,
      speakerId: "human-1",
      startMs: 1_000,
      text: "The corrected launch date is Monday.",
      turnId: "turn-1",
    });
    const worker = new LiveFinalizedMemoryWorker(
      new PostgresLiveFinalizedMemoryStore(database),
      { hash: canonicalFinalReplyTurnHash },
    );
    await expect(worker.executeOnce({ meetingId })).resolves.toMatchObject({
      status: "applied",
    });

    const rollback = await database.connect();
    try {
      await rollback.query("BEGIN");
      await retireLiveFinalizedMemoryGeneration(rollback, meetingId, "ended");
      await expect(hotTailCount(rollback, meetingId)).resolves.toBe(0);
      await rollback.query("ROLLBACK");
    } finally {
      rollback.release();
    }
    await expect(hotTailCount(database, meetingId)).resolves.toBe(1);

    const commit = await database.connect();
    try {
      await commit.query("BEGIN");
      await retireLiveFinalizedMemoryGeneration(commit, meetingId, "ended");
      await commit.query("COMMIT");
    } finally {
      commit.release();
    }
    await expect(worker.executeOnce({ meetingId })).resolves.toMatchObject({
      status: "applied",
    });
    await expect(database.query(
      `SELECT state FROM meeting_knowledge.live_memory_outbox WHERE meeting_id = $1`,
      [meetingId],
    )).resolves.toMatchObject({ rows: [{ state: "retired" }] });
  });
});

async function hotTailCount(
  executor: { query(sql: string, values: readonly unknown[]): Promise<{ rows: unknown[] }> },
  meetingId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT count(*)::integer AS count
     FROM meeting_knowledge.live_memory_hot_tail WHERE meeting_id = $1`,
    [meetingId],
  );
  return (result.rows[0] as { readonly count: number } | undefined)?.count ?? -1;
}
