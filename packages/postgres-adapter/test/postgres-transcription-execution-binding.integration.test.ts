import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import {
  createIsolatedDatabase,
  databaseOrSkip,
  recordedMeeting,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";
import {
  PostgresMeetingRepository,
  PostgresMigrationRunner,
  PostgresTranscriptionExecutionBindingStore,
} from "../src/index.js";

const selectedBinding = "voicetext-batch-v3:elevenlabs-scribe-v2";
const selectedBindings = new Set([selectedBinding]);
const admissionQueryPattern = "%transcription_execution_binding_admission_v1%";

usePostgresIntegrationDatabase();

async function waitForAdmissionBackend(
  database: ReturnType<typeof databaseOrSkip>,
): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await database.query<{ readonly pid: number }>(`
      SELECT pid::float8 AS pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND query LIKE $1
      ORDER BY pid
      LIMIT 1
    `, [admissionQueryPattern]);
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) {
      return pid;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("PostgreSQL admission cancellation probe did not start");
}

async function backendIsActive(
  database: ReturnType<typeof databaseOrSkip>,
  backendPid: number,
): Promise<boolean> {
  const result = await database.query<{ readonly active: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE pid = $1 AND state = 'active'
    ) AS active
  `, [backendPid]);
  return result.rows[0]?.active === true;
}

describe("Postgres transcription execution binding", () => {
  it("cancels an admission read and proves its PostgreSQL backend inactive", async (context) => {
    databaseOrSkip(context);
    const isolated = await createIsolatedDatabase();
    const controller = new AbortController();
    const cancellation = new Error("synthetic admission cancellation");
    let operation: Promise<unknown> | undefined;
    let backendPid: number | undefined;
    let locker: PoolClient | undefined;
    try {
      await new PostgresMigrationRunner(isolated.pool).migrate();
      const repository = new PostgresMeetingRepository(isolated.pool);
      const bindings = new PostgresTranscriptionExecutionBindingStore(isolated.pool);
      const snapshot = recordedMeeting("meeting-binding-admission-cancel").toSnapshot();
      await repository.recordAndSchedule(snapshot, 0, selectedBinding);
      locker = await isolated.pool.connect();
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE meeting_core.post_call_outbox IN ACCESS EXCLUSIVE MODE");

      operation = bindings.getTranscriptionExecutionBinding(
        snapshot.meetingId,
        controller.signal,
      );
      backendPid = await waitForAdmissionBackend(isolated.pool);
      controller.abort(cancellation);

      await expect(operation).rejects.toBe(cancellation);
      await expect(backendIsActive(isolated.pool, backendPid)).resolves.toBe(false);
    } finally {
      if (!controller.signal.aborted) {
        controller.abort(new Error("synthetic admission probe cleanup"));
      }
      await operation?.catch(() => {});
      if (backendPid !== undefined) {
        await isolated.pool.query(
          "SELECT pg_terminate_backend($1) FROM pg_stat_activity WHERE pid = $1",
          [backendPid],
        );
      }
      await locker?.query("ROLLBACK").catch(() => {});
      locker?.release();
      await isolated.dispose();
    }
  }, 45_000);

  it("records one immutable binding atomically and preserves it across recovery", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const bindings = new PostgresTranscriptionExecutionBindingStore(database);
    const snapshot = recordedMeeting("meeting-binding-pin").toSnapshot();
    await repository.recordAndSchedule(snapshot, 0, selectedBinding);

    await expect(bindings.getTranscriptionExecutionBinding(snapshot.meetingId))
      .resolves.toBe(selectedBinding);
    await expect(bindings.pinTranscriptionExecutionBinding(
      snapshot.meetingId,
      "voicetext-batch-v3:elevenlabs-scribe-v2",
    )).resolves.toBe(selectedBinding);
    await expect(bindings.pinTranscriptionExecutionBinding(
      snapshot.meetingId,
      "voicetext-batch-v2:deepgram-nova-3",
    )).resolves.toBe(selectedBinding);
    await repository.markPostCallEnqueued(snapshot.meetingId);
    expect(await repository.listRecoverablePostCall(100, selectedBindings)).toEqual([{
      meetingId: snapshot.meetingId,
      recoveryGeneration: 0,
      schemaVersion: 1,
    }]);
    await expect(database.query(`
      UPDATE meeting_core.post_call_outbox
      SET transcription_execution_binding = 'voicetext-batch-v2:deepgram-nova-3'
      WHERE meeting_id = $1
    `, [snapshot.meetingId])).rejects.toMatchObject({ code: "23514" });
  });

  it("hides binding-aware work from the literal V1 recovery query", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const snapshot = recordedMeeting("meeting-binding-v1-fence").toSnapshot();
    await repository.recordAndSchedule(snapshot, 0, selectedBinding);

    const legacyView = await database.query<{ readonly meeting_id: string }>(`
      SELECT meeting_id
      FROM meeting_core.post_call_outbox
      WHERE processed_at IS NULL
        AND dead_lettered_at IS NULL
        AND (recovery_after IS NULL OR recovery_after <= transaction_timestamp())
      ORDER BY COALESCE(recovery_after, created_at), meeting_id
      LIMIT 100
    `);
    expect(legacyView.rows).toEqual([]);
    expect(await repository.listRecoverablePostCall(100, selectedBindings)).toEqual([{
      meetingId: snapshot.meetingId,
      recoveryGeneration: 0,
      schemaVersion: 1,
    }]);
  });

  it("filters held unsupported bindings before applying the recovery page limit", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    await repository.recordAndSchedule(
      recordedMeeting("meeting-binding-held-a").toSnapshot(),
      0,
      "voicetext-batch-v3:future-provider",
    );
    await repository.recordAndSchedule(
      recordedMeeting("meeting-binding-held-b").toSnapshot(),
      0,
      "voicetext-batch-v3:future-provider",
    );
    const supported = recordedMeeting("meeting-binding-supported").toSnapshot();
    await repository.recordAndSchedule(supported, 0, selectedBinding);

    expect(await repository.listRecoverablePostCall(1, selectedBindings)).toEqual([{
      meetingId: supported.meetingId,
      recoveryGeneration: 0,
      schemaVersion: 1,
    }]);
  });

  it("backfills only recoverable legacy rows to the explicitly supplied binding", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const bindings = new PostgresTranscriptionExecutionBindingStore(database);
    const recoverable = recordedMeeting("meeting-binding-legacy").toSnapshot();
    const processed = recordedMeeting("meeting-binding-processed").toSnapshot();
    await repository.save(recoverable, 0);
    await database.query(`
      INSERT INTO meeting_core.post_call_outbox (
        meeting_id,
        schema_version,
        transcription_execution_binding_required
      ) VALUES ($1, 1, FALSE)
    `, [recoverable.meetingId]);
    await repository.recordAndSchedule(processed, 0, selectedBinding);
    await repository.markPostCallProcessed(processed.meetingId);

    await expect(bindings.backfillRecoverableUnboundTranscriptionExecutionBindings(
      "voicetext-batch-v2:deepgram-nova-3",
    )).resolves.toBe(1);
    await expect(bindings.getTranscriptionExecutionBinding(recoverable.meetingId))
      .resolves.toBe("voicetext-batch-v2:deepgram-nova-3");
    await expect(bindings.getTranscriptionExecutionBinding(processed.meetingId))
      .resolves.toBe(selectedBinding);
    await expect(bindings.pinTranscriptionExecutionBinding(
      processed.meetingId,
      "voicetext-batch-v3:elevenlabs-scribe-v2",
    )).rejects.toThrow("transcription execution binding does not reference one outbox item");
  });

  it("keeps rolling-deploy legacy inserts recoverable without weakening new atomic writes", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const bindings = new PostgresTranscriptionExecutionBindingStore(database);
    const legacy = recordedMeeting("meeting-binding-rolling-legacy").toSnapshot();

    await repository.save(legacy, 0);
    await database.query(`
      INSERT INTO meeting_core.post_call_outbox (meeting_id, schema_version)
      VALUES ($1, 1)
    `, [legacy.meetingId]);

    await expect(bindings.backfillRecoverableUnboundTranscriptionExecutionBindings(
      "voicetext-batch-v2:deepgram-nova-3",
    )).resolves.toBe(1);
    await expect(bindings.getTranscriptionExecutionBinding(legacy.meetingId))
      .resolves.toBe("voicetext-batch-v2:deepgram-nova-3");
  });

  it("skips a locked legacy row and commits an independently bounded batch", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const bindings = new PostgresTranscriptionExecutionBindingStore(database);
    const locked = recordedMeeting("meeting-binding-locked-legacy").toSnapshot();
    const available = recordedMeeting("meeting-binding-available-legacy").toSnapshot();
    await repository.save(locked, 0);
    await repository.save(available, 0);
    await database.query(`
      INSERT INTO meeting_core.post_call_outbox (
        meeting_id, schema_version, transcription_execution_binding_required
      ) VALUES ($1, 1, FALSE), ($2, 1, FALSE)
    `, [locked.meetingId, available.meetingId]);

    const locker = await database.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(`
        SELECT meeting_id
        FROM meeting_core.post_call_outbox
        WHERE meeting_id = $1
        FOR UPDATE
      `, [locked.meetingId]);

      await expect(bindings.backfillRecoverableUnboundTranscriptionExecutionBindings(
        "voicetext-batch-v2:deepgram-nova-3",
      )).resolves.toBe(1);
      await expect(bindings.getTranscriptionExecutionBinding(available.meetingId))
        .resolves.toBe("voicetext-batch-v2:deepgram-nova-3");
      await expect(bindings.getTranscriptionExecutionBinding(locked.meetingId))
        .resolves.toBeUndefined();
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }

    await expect(bindings.backfillRecoverableUnboundTranscriptionExecutionBindings(
      "voicetext-batch-v2:deepgram-nova-3",
    )).resolves.toBe(1);
    await expect(bindings.getTranscriptionExecutionBinding(locked.meetingId))
      .resolves.toBe("voicetext-batch-v2:deepgram-nova-3");
  });

  it("bounds per-dispatch pinning on a locked row and remains usable", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const bindings = new PostgresTranscriptionExecutionBindingStore(database);
    const locked = recordedMeeting("meeting-binding-locked-pin").toSnapshot();
    const available = recordedMeeting("meeting-binding-available-pin").toSnapshot();
    for (const snapshot of [locked, available]) {
      await repository.save(snapshot, 0);
      await database.query(`
        INSERT INTO meeting_core.post_call_outbox (
          meeting_id, schema_version, transcription_execution_binding_required
        ) VALUES ($1, 1, FALSE)
      `, [snapshot.meetingId]);
    }

    const locker = await database.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(`
        SELECT meeting_id
        FROM meeting_core.post_call_outbox
        WHERE meeting_id = $1
        FOR UPDATE
      `, [locked.meetingId]);

      const startedAt = performance.now();
      await expect(bindings.pinTranscriptionExecutionBinding(
        locked.meetingId,
        "voicetext-batch-v2:deepgram-nova-3",
      )).rejects.toMatchObject({ code: "55P03" });
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      await expect(bindings.pinTranscriptionExecutionBinding(
        available.meetingId,
        "voicetext-batch-v2:deepgram-nova-3",
      )).resolves.toBe("voicetext-batch-v2:deepgram-nova-3");
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }

    await expect(bindings.pinTranscriptionExecutionBinding(
      locked.meetingId,
      "voicetext-batch-v2:deepgram-nova-3",
    )).resolves.toBe("voicetext-batch-v2:deepgram-nova-3");
  });
});
