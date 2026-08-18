import { describe, expect, it } from "vitest";

import {
  databaseOrSkip,
  recordedMeeting,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";
import {
  PostgresMeetingRepository,
  PostgresTranscriptionExecutionBindingStore,
} from "../src/index.js";

const selectedBinding = "voicetext-batch-v3:elevenlabs-scribe-v2";

usePostgresIntegrationDatabase();

describe("Postgres transcription execution binding", () => {
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
    expect(await repository.listRecoverablePostCall()).toEqual([{
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
});
