import {
  LiveMeeting,
  type LiveGenerationTelemetrySnapshot,
  type LiveGenerationUsageSnapshot,
} from "@discord-meeting/meeting-core";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createIsolatedDatabase,
  databaseOrSkip,
  finalizedLiveTurn,
  liveGenerationTelemetry,
  liveGenerationUsage,
  liveSummary,
  requiredAppendOnlyLiveMeetingMigration,
  requiredLegacyLiveMigrations,
  usePostgresIntegrationDatabase,
  waitForTimelineReadToBlock,
} from "./postgres-integration-fixtures.js";
import {
  MeetingPersistenceConflictError,
  PostgresLiveMeetingRepository,
} from "../src/index.js";

usePostgresIntegrationDatabase();

describe("PostgresLiveMeetingRepository", () => {
  it("stores compact state while appending turns and operational records", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresLiveMeetingRepository(database);
    const meeting = LiveMeeting.start({
      meetingId: "live-postgres-1",
      publicationTargetId: "discord-channel-1",
      startedAtMs: 10_000,
    });
    const initial = meeting.toSnapshot();

    await repository.save(initial, null);
    await repository.save(initial, null);
    const turn = finalizedLiveTurn();

    expect(await repository.appendFinalizedTurn(meeting.meetingId, turn)).toBe("appended");
    expect(await repository.appendFinalizedTurn(meeting.meetingId, turn)).toBe("reused");
    await expect(repository.appendFinalizedTurn(meeting.meetingId, {
      ...turn,
      text: "Эта реплика не может заменить зафиксированную.",
    })).rejects.toThrow("live turn identity was reused with different content");
    const afterTurn = await repository.findById(meeting.meetingId);
    expect(afterTurn).toEqual({ ...initial, revision: initial.revision + 1 });
    expect(await repository.listFinalizedTurns(meeting.meetingId)).toEqual([
      { isSummarized: false, turn },
    ]);

    const usage = liveGenerationUsage();
    const telemetry = liveGenerationTelemetry();
    expect(await repository.appendGenerationUsage(meeting.meetingId, usage)).toBe("appended");
    expect(await repository.appendGenerationUsage(meeting.meetingId, usage)).toBe("reused");
    await expect(repository.appendGenerationUsage(meeting.meetingId, {
      ...usage,
      model: "gpt-5.6-luna-replayed-differently",
    })).rejects.toThrow("generation run was replayed with different values");
    expect(await repository.appendGenerationTelemetry(meeting.meetingId, telemetry)).toBe("appended");
    expect(await repository.appendGenerationTelemetry(meeting.meetingId, telemetry)).toBe("reused");
    expect(await repository.findById(meeting.meetingId)).toEqual(afterTurn);

    if (afterTurn === null) {
      throw new Error("live meeting disappeared after finalized turn append");
    }
    const summarized = LiveMeeting.restore(afterTurn);
    summarized.acceptSummary({
      evidenceTurns: [turn],
      generatedAtMs: 16_000,
      summary: liveSummary(turn.turnId),
    });
    await repository.commitSummary({
      expectedRevision: afterTurn.revision,
      newlySummarizedTurnIds: [turn.turnId],
      snapshot: summarized.toSnapshot(),
    });

    expect(await repository.findById(meeting.meetingId)).toEqual(summarized.toSnapshot());
    expect(await repository.listFinalizedTurns(meeting.meetingId)).toEqual([
      { isSummarized: true, turn },
    ]);
  });

  it("rejects a stale live revision", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresLiveMeetingRepository(database);
    const meeting = LiveMeeting.start({
      meetingId: "live-postgres-conflict",
      publicationTargetId: "discord-channel-1",
      startedAtMs: 0,
    });
    const initial = meeting.toSnapshot();
    await repository.save(initial, null);
    await repository.appendFinalizedTurn(meeting.meetingId, finalizedLiveTurn());
    const competing = LiveMeeting.restore(initial);
    competing.end(3_000);

    await expect(repository.save(competing.toSnapshot(), initial.revision)).rejects.toBeInstanceOf(
      MeetingPersistenceConflictError,
    );
  });

  it("returns a state and timeline from one repeatable-read PostgreSQL snapshot", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresLiveMeetingRepository(database);
    const meeting = LiveMeeting.start({
      meetingId: "live-postgres-atomic-read",
      publicationTargetId: "discord-channel-1",
      startedAtMs: 0,
    });
    const initial = meeting.toSnapshot();
    const concurrentTurn = finalizedLiveTurn("turn-written-between-reads");
    await repository.save(initial, null);

    const writer = await database.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("LOCK TABLE meeting_core.live_meeting_turns IN ACCESS EXCLUSIVE MODE");
      const atomicRead = repository.readSnapshotAndTimeline(meeting.meetingId);
      await waitForTimelineReadToBlock(database);

      await writer.query(
        `
          INSERT INTO meeting_core.live_meeting_turns
            (meeting_id, turn_id, start_ms, end_ms, speaker_id, turn)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        `,
        [
          meeting.meetingId,
          concurrentTurn.turnId,
          concurrentTurn.startMs,
          concurrentTurn.endMs,
          concurrentTurn.speakerId,
          concurrentTurn,
        ],
      );
      await writer.query(
        `
          UPDATE meeting_core.live_meetings
          SET revision = revision + 1,
              snapshot = jsonb_set(snapshot, '{revision}', to_jsonb(revision + 1), false)
          WHERE meeting_id = $1
        `,
        [meeting.meetingId],
      );
      await writer.query("COMMIT");

      await expect(atomicRead).resolves.toEqual({
        snapshot: initial,
        timeline: [],
      });
    } finally {
      try {
        await writer.query("ROLLBACK");
      } catch {
        // A committed transaction has nothing left to roll back.
      }
      writer.release();
    }
  });

  it("migrates embedded live records to append-only tables without changing lifecycle state", async (context) => {
    databaseOrSkip(context);
    const appendOnlyMigration = requiredAppendOnlyLiveMeetingMigration();
    const legacyMigrations = requiredLegacyLiveMigrations();
    const isolated = await createIsolatedDatabase();
    const database = isolated.pool;
    try {
      await database.query(legacyMigrations.meetingCore);
      await database.query(legacyMigrations.liveMeetings);
      const repository = new PostgresLiveMeetingRepository(database);
      const turn = finalizedLiveTurn("turn-legacy-1");
      const legacyMeeting = LiveMeeting.start({
        meetingId: "live-postgres-legacy",
        publicationTargetId: "discord-channel-1",
        startedAtMs: 10_000,
      });
      legacyMeeting.acceptSummary({
        evidenceTurns: [turn],
        generatedAtMs: 16_000,
        summary: liveSummary(turn.turnId),
      });
      const expectedCompactSnapshot = {
        ...legacyMeeting.toSnapshot(),
        revision: 2,
      };
      const usage = liveGenerationUsage("usage-legacy-1");
      const telemetry = liveGenerationTelemetry("telemetry-legacy-1");
      const legacySnapshot = {
        ...expectedCompactSnapshot,
        generationTelemetry: [telemetry],
        generationUsage: [usage],
        summarizedTurnIds: [turn.turnId],
        turns: [turn],
      };

      await database.query(
        `
          INSERT INTO meeting_core.live_meetings (meeting_id, revision, snapshot)
          VALUES ($1, $2, $3::jsonb)
        `,
        [expectedCompactSnapshot.meetingId, expectedCompactSnapshot.revision, legacySnapshot],
      );
      await database.query(appendOnlyMigration);

      expect(await repository.findById(expectedCompactSnapshot.meetingId)).toEqual(
        expectedCompactSnapshot,
      );
      expect(await repository.listFinalizedTurns(expectedCompactSnapshot.meetingId)).toEqual([
        { isSummarized: true, turn },
      ]);
      const migrated = await database.query<{
        readonly snapshot: unknown;
        readonly telemetry: LiveGenerationTelemetrySnapshot;
        readonly usage: LiveGenerationUsageSnapshot;
        readonly summary_revision: number;
      }>(`
        SELECT live.snapshot,
               (
                 SELECT payload
                 FROM meeting_core.live_meeting_generation_usage
                 WHERE meeting_id = live.meeting_id
               ) AS usage,
               (
                 SELECT payload
                 FROM meeting_core.live_meeting_generation_telemetry
                 WHERE meeting_id = live.meeting_id
               ) AS telemetry,
               (
                 SELECT first_summary_revision::float8
                 FROM meeting_core.live_meeting_summary_coverage
                 WHERE meeting_id = live.meeting_id
                   AND turn_id = $2
               ) AS summary_revision
        FROM meeting_core.live_meetings AS live
        WHERE live.meeting_id = $1
      `, [expectedCompactSnapshot.meetingId, turn.turnId]);

      expect(migrated.rows).toEqual([{
        snapshot: expectedCompactSnapshot,
        summary_revision: 1,
        telemetry,
        usage,
      }]);
      await expect(database.query(
        `
          UPDATE meeting_core.live_meetings
          SET snapshot = snapshot || '{"turns": []}'::jsonb
          WHERE meeting_id = $1
        `,
        [expectedCompactSnapshot.meetingId],
      )).rejects.toThrow("live_meetings_snapshot_excludes_legacy_records");
    } finally {
      await isolated.dispose();
    }
  });
});
