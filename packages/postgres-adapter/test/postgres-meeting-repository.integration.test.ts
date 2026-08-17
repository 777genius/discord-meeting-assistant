import { GuildConfiguration } from "@discord-meeting/guild-configuration-core";
import {
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core/meeting-lifecycle";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  configuredGuild,
  databaseOrSkip,
  evidenceBackedMeeting,
  recordedMeeting,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";
import {
  MeetingPersistenceConflictError,
  PostCallDeadLetterConflictError,
  PostgresGuildConfigurationRepository,
  PostgresMeetingRepository,
  PostgresSummaryPublicationEffectLedger,
  PostgresTranscriptionExecutionBindingStore,
} from "../src/index.js";

usePostgresIntegrationDatabase();

describe("PostgresSummaryPublicationEffectLedger", () => {
  it("retains an unresolved create fence and reconciles one exact receipt", async (context) => {
    const ledger = new PostgresSummaryPublicationEffectLedger(
      databaseOrSkip(context),
    );
    const reservation = {
      projectionKey: "meeting-projection-1",
      publicationTargetId: "11111111111111111",
    };

    await expect(ledger.reserveSummaryPublicationEffect(reservation))
      .resolves.toEqual({ status: "acquired" });
    await expect(ledger.reserveSummaryPublicationEffect(reservation))
      .resolves.toEqual({ status: "pending" });
    await ledger.completeSummaryPublicationEffect({
      ...reservation,
      externalReceipt:
        "discord:v2:channel:11111111111111111:message:22222222222222222",
    });
    await expect(ledger.reserveSummaryPublicationEffect(reservation))
      .resolves.toEqual({
        externalReceipt:
          "discord:v2:channel:11111111111111111:message:22222222222222222",
        status: "completed",
      });
  });
});

describe("PostgresGuildConfigurationRepository", () => {
  it("persists, restores and compare-and-swaps a guild configuration", async (context) => {
    const repository = new PostgresGuildConfigurationRepository(databaseOrSkip(context));
    const initial = configuredGuild();
    expect(await repository.save(initial.toSnapshot(), null)).toEqual({ status: "saved" });
    expect(await repository.findByGuildId(initial.guildId)).toEqual(initial.toSnapshot());

    const changed = initial.reconfigure({
      ...initial.toSnapshot(),
      configuredByUserId: "55555555555555555",
      resultsChannelId: "66666666666666666",
    });
    expect(await repository.save(changed.toSnapshot(), 0)).toEqual({ status: "saved" });
    expect((await repository.findByGuildId(initial.guildId))?.revision).toBe(1);
  });

  it("lists only active guild voice channels in deterministic guild order", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresGuildConfigurationRepository(database);
    const configurations = [
      GuildConfiguration.configure({
        configuredByUserId: "11111111111111111",
        guildId: "33333333333333333",
        resultsChannelId: "44444444444444444",
        voiceChannelId: "55555555555555555",
      }),
      GuildConfiguration.configure({
        configuredByUserId: "11111111111111111",
        guildId: "11111111111111111",
        resultsChannelId: "22222222222222222",
        voiceChannelId: "33333333333333333",
      }),
      GuildConfiguration.configure({
        configuredByUserId: "11111111111111111",
        guildId: "22222222222222222",
        resultsChannelId: "33333333333333333",
        voiceChannelId: "44444444444444444",
      }),
    ];
    for (const configuration of configurations) {
      await repository.save(configuration.toSnapshot(), null);
    }
    await database.query(
      `
        INSERT INTO guild_configuration.guild_installations (guild_id, revision, snapshot)
        VALUES ($1, $2, $3::jsonb)
      `,
      [
        "99999999999999999",
        0,
        {
          configuredByUserId: "11111111111111111",
          guildId: "99999999999999999",
          resultsChannelId: "22222222222222222",
          revision: 0,
          status: "inactive",
          voiceChannelId: "33333333333333333",
        },
      ],
    );

    expect(await repository.listActiveGuildVoiceChannels()).toEqual([
      {
        guildId: "11111111111111111",
        voiceChannelId: "33333333333333333",
      },
      {
        guildId: "22222222222222222",
        voiceChannelId: "44444444444444444",
      },
      {
        guildId: "33333333333333333",
        voiceChannelId: "55555555555555555",
      },
    ]);
  });

  it("reports insert and update conflicts without overwriting", async (context) => {
    const repository = new PostgresGuildConfigurationRepository(databaseOrSkip(context));
    const initial = configuredGuild();
    await repository.save(initial.toSnapshot(), null);
    expect(await repository.save(initial.toSnapshot(), null)).toEqual({
      actualRevision: 0,
      status: "conflict",
    });
    const changed = initial.reconfigure({
      ...initial.toSnapshot(),
      resultsChannelId: "66666666666666666",
    });
    await repository.save(changed.toSnapshot(), 0);
    const stale = initial.reconfigure({
      ...initial.toSnapshot(),
      resultsChannelId: "77777777777777777",
    });
    expect(await repository.save(stale.toSnapshot(), 0)).toEqual({
      actualRevision: 1,
      status: "conflict",
    });
  });
});

describe("PostgresMeetingRepository", () => {
  it("keeps an enqueued post-call item recoverable until a durable processing receipt", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const snapshot = recordedMeeting("meeting-outbox-1").toSnapshot();

    await repository.recordAndSchedule(snapshot, 0);
    await repository.recordAndSchedule(snapshot, 0);
    expect(await repository.listRecoverablePostCall()).toEqual([
      { meetingId: snapshot.meetingId, recoveryGeneration: 0, schemaVersion: 1 },
    ]);

    await repository.markPostCallEnqueued(snapshot.meetingId);
    expect(await repository.listRecoverablePostCall()).toEqual([
      { meetingId: snapshot.meetingId, recoveryGeneration: 0, schemaVersion: 1 },
    ]);
    await repository.markPostCallProcessed(snapshot.meetingId);
    expect(await repository.listRecoverablePostCall()).toEqual([]);
    expect(await repository.findById(snapshot.meetingId)).toEqual(snapshot);
  });

  it("pins one immutable execution binding and preserves it across recovery", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const bindings = new PostgresTranscriptionExecutionBindingStore(database);
    const snapshot = recordedMeeting("meeting-binding-pin").toSnapshot();
    await repository.recordAndSchedule(snapshot, 0);

    await expect(bindings.getTranscriptionExecutionBinding(snapshot.meetingId))
      .resolves.toBeUndefined();
    await expect(bindings.pinTranscriptionExecutionBinding(
      snapshot.meetingId,
      "voicetext-batch-v3:elevenlabs-scribe-v2",
    )).resolves.toBe("voicetext-batch-v3:elevenlabs-scribe-v2");
    await expect(bindings.pinTranscriptionExecutionBinding(
      snapshot.meetingId,
      "voicetext-batch-v2:deepgram-nova-3",
    )).resolves.toBe("voicetext-batch-v3:elevenlabs-scribe-v2");
    await expect(bindings.getTranscriptionExecutionBinding(snapshot.meetingId))
      .resolves.toBe("voicetext-batch-v3:elevenlabs-scribe-v2");
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
    await repository.recordAndSchedule(recoverable, 0);
    await repository.recordAndSchedule(processed, 0);
    await repository.markPostCallProcessed(processed.meetingId);

    await expect(bindings.backfillRecoverableUnboundTranscriptionExecutionBindings(
      "voicetext-batch-v2:deepgram-nova-3",
    )).resolves.toBe(1);
    await expect(bindings.getTranscriptionExecutionBinding(recoverable.meetingId))
      .resolves.toBe("voicetext-batch-v2:deepgram-nova-3");
    await expect(bindings.getTranscriptionExecutionBinding(processed.meetingId))
      .resolves.toBeUndefined();
    await expect(bindings.pinTranscriptionExecutionBinding(
      processed.meetingId,
      "voicetext-batch-v3:elevenlabs-scribe-v2",
    )).rejects.toThrow("transcription execution binding does not reference one outbox item");
  });

  it("accepts a finalized-ingress replay after post-call processing advanced the meeting", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const initial = recordedMeeting("meeting-ready-replay").toSnapshot();
    await repository.recordAndSchedule(initial, 0);

    const processed = evidenceBackedMeeting("meeting-ready-replay").toSnapshot();
    await repository.save(processed, 0);
    await repository.markPostCallProcessed(initial.meetingId);

    await expect(repository.recordAndSchedule(initial, 0)).resolves.toBeUndefined();
    expect(await repository.findById(initial.meetingId)).toEqual(processed);
    expect(await repository.listRecoverablePostCall()).toEqual([]);
  });

  it("fails closed for an unknown processing receipt and records idempotent dead-letter evidence", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const sourceJobRef = "a".repeat(64);
    const record = {
      attemptsMade: 4,
      failureCode: "SUMMARY_PROVIDER_FAILED",
      meetingId: "meeting-dead-letter-1",
      retryable: false,
      schemaVersion: 1 as const,
      sourceJobRef,
    };

    await expect(repository.markPostCallProcessed(record.meetingId)).rejects.toThrow(
      "post-call processing receipt does not reference one outbox item",
    );
    expect(await repository.recordPostCallDeadLetter(record)).toBe("recorded");
    expect(await repository.recordPostCallDeadLetter(record)).toBe("reused");
    await expect(repository.recordPostCallDeadLetter({
      ...record,
      attemptsMade: record.attemptsMade + 1,
    })).rejects.toBeInstanceOf(PostCallDeadLetterConflictError);
    const evidence = await repository.listPostCallDeadLetters();
    expect(evidence).toHaveLength(1);
    const deadLetter = evidence[0];
    if (deadLetter === undefined) {
      throw new Error("recorded post-call dead-letter evidence disappeared");
    }
    expect(deadLetter).toMatchObject(record);
    expect(new Date(deadLetter.recordedAt).toISOString()).toBe(deadLetter.recordedAt);
  });

  it("atomically settles a non-retryable failure so reconciliation cannot rerun it", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const snapshot = recordedMeeting("meeting-terminal-settlement").toSnapshot();
    await repository.recordAndSchedule(snapshot, 0);
    const record = {
      attemptsMade: 4,
      failureCode: "SUMMARY_PROVIDER_FAILED",
      meetingId: snapshot.meetingId,
      retryable: false,
      schemaVersion: 1 as const,
      sourceJobRef: "b".repeat(64),
    };

    expect(await repository.settlePostCallFailure(record)).toBe("recorded");
    expect(await repository.settlePostCallFailure(record)).toBe("reused");
    expect(await repository.listRecoverablePostCall()).toEqual([]);
    await expect(repository.markPostCallProcessed(snapshot.meetingId)).rejects.toThrow(
      "post-call processing receipt does not reference one outbox item",
    );
    const receipt = await database.query<{
      readonly dead_letter_source_job_ref: string;
      readonly terminal: boolean;
    }>(`
      SELECT dead_letter_source_job_ref, dead_lettered_at IS NOT NULL AS terminal
      FROM meeting_core.post_call_outbox
      WHERE meeting_id = $1
    `, [snapshot.meetingId]);
    expect(receipt.rows).toEqual([{
      dead_letter_source_job_ref: record.sourceJobRef,
      terminal: true,
    }]);
  });
});

describe("Postgres retryable post-call recovery", () => {
  it("rejects an incomplete durable recovery receipt", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const snapshot = recordedMeeting("meeting-invalid-recovery-receipt").toSnapshot();
    await repository.recordAndSchedule(snapshot, 0);

    await expect(database.query(`
      UPDATE meeting_core.post_call_outbox
      SET recovery_generation = 1,
          recovery_after = transaction_timestamp()
      WHERE meeting_id = $1
    `, [snapshot.meetingId])).rejects.toMatchObject({ code: "23514" });
  });

  it("schedules each exhausted retryable generation exactly once", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const snapshot = recordedMeeting("meeting-retryable-recovery").toSnapshot();
    await repository.recordAndSchedule(snapshot, 0);
    const firstFailure = {
      attemptsMade: 8,
      failureCode: "SUMMARY_PROVIDER_UNAVAILABLE",
      meetingId: snapshot.meetingId,
      retryable: true,
      schemaVersion: 1 as const,
      sourceJobRef: "c".repeat(64),
    };

    expect(await repository.settlePostCallFailure(firstFailure)).toBe("recorded");
    expect(await repository.settlePostCallFailure(firstFailure)).toBe("reused");
    expect(await repository.listRecoverablePostCall()).toEqual([]);

    const scheduled = await database.query<{
      readonly delay_seconds: number;
      readonly recovery_generation: number;
      readonly recovery_source_job_ref: string;
    }>(`
      SELECT recovery_generation::float8 AS recovery_generation,
             recovery_source_job_ref,
             EXTRACT(EPOCH FROM (recovery_after - recorded_at))::float8 AS delay_seconds
      FROM meeting_core.post_call_outbox
      JOIN meeting_core.post_call_dead_letters
        ON source_job_ref = recovery_source_job_ref
      WHERE meeting_core.post_call_outbox.meeting_id = $1
    `, [snapshot.meetingId]);
    expect(scheduled.rows).toHaveLength(1);
    expect(scheduled.rows[0]).toMatchObject({
      recovery_generation: 1,
      recovery_source_job_ref: firstFailure.sourceJobRef,
    });
    expect(scheduled.rows[0]?.delay_seconds).toBeCloseTo(300, 0);

    await database.query(`
      UPDATE meeting_core.post_call_outbox
      SET recovery_after = transaction_timestamp() - interval '1 second'
      WHERE meeting_id = $1
    `, [snapshot.meetingId]);
    expect(await repository.listRecoverablePostCall()).toEqual([{
      meetingId: snapshot.meetingId,
      recoveryGeneration: 1,
      schemaVersion: 1,
    }]);

    const secondFailure = {
      ...firstFailure,
      sourceJobRef: "d".repeat(64),
    };
    expect(await repository.settlePostCallFailure(secondFailure)).toBe("recorded");
    const secondSchedule = await database.query<{
      readonly delay_seconds: number;
      readonly recovery_generation: number;
    }>(`
      SELECT recovery_generation::float8 AS recovery_generation,
             EXTRACT(EPOCH FROM (recovery_after - transaction_timestamp()))::float8
               AS delay_seconds
      FROM meeting_core.post_call_outbox
      WHERE meeting_id = $1
    `, [snapshot.meetingId]);
    expect(secondSchedule.rows[0]?.recovery_generation).toBe(2);
    expect(secondSchedule.rows[0]?.delay_seconds).toBeCloseTo(1_800, 0);
  });
});

describe("PostgresMeetingRepository persistence", () => {
  it("round-trips the complete JSONB evidence snapshot", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const initial = recordedMeeting().toSnapshot();
    await repository.save(initial, initial.revision);

    const expected = evidenceBackedMeeting().toSnapshot();
    await repository.save(expected, initial.revision);

    const restored = await repository.findById(expected.meetingId);
    expect(restored).toEqual(expected);
    expect(restored?.transcript?.turns).toHaveLength(2);
    expect(restored?.summary?.decisions[0]?.evidenceTurnIds).toEqual([
      "turn-decision",
    ]);
    expect(restored?.summary?.actionItems[0]?.ownerSpeakerId).toBe("speaker-b");
    expect(restored?.summary?.openQuestions).toEqual([
      {
        evidenceTurnIds: ["turn-action"],
        id: "question-final-deployment",
        text: "Who runs the final deployment?",
      },
    ]);
  });

  it("restores legacy string questions into the unverified quarantine", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const current = evidenceBackedMeeting("meeting-legacy-questions").toSnapshot();
    const legacy = {
      ...current,
      summary: {
        ...current.summary,
        openQuestions: ["Who runs the final deployment?"],
      },
    };
    await database.query(
      `
        INSERT INTO meeting_core.meetings (meeting_id, revision, snapshot)
        VALUES ($1, $2, $3::jsonb)
      `,
      [legacy.meetingId, legacy.revision, legacy],
    );

    const restored = await repository.findById(legacy.meetingId);

    expect(restored?.summary).toMatchObject({
      legacyUnverifiedOpenQuestions: ["Who runs the final deployment?"],
      openQuestions: [],
    });
  });

  it("treats identical inserts and CAS retries as idempotent", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const initial = recordedMeeting().toSnapshot();
    await repository.save(initial, 0);
    await repository.save(initial, 0);

    const updated = evidenceBackedMeeting().toSnapshot();
    await repository.save(updated, 0);
    await repository.save(updated, 0);

    expect(await repository.findById(initial.meetingId)).toEqual(updated);
  });

  it("reports a structured conflict for a different duplicate insert", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const original = recordedMeeting().toSnapshot();
    const competing = recordedMeeting(
      original.meetingId,
      "s3://recordings/competing/manifest.json",
    ).toSnapshot();
    await repository.save(original, 0);

    await expect(repository.save(competing, 0)).rejects.toMatchObject({
      code: "MEETING_PERSISTENCE_CONFLICT",
      conflict: {
        actualRevision: 0,
        attemptedRevision: 0,
        expectedRevision: 0,
        kind: "meeting-already-exists",
        meetingId: original.meetingId,
      },
    });
    expect(await repository.findById(original.meetingId)).toEqual(original);
  });

  it("allows only one competing optimistic update", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const initial = recordedMeeting().toSnapshot();
    await repository.save(initial, 0);

    const first = recordedMeeting(initial.meetingId);
    first.beginTranscription();
    const second = recordedMeeting(
      initial.meetingId,
      "s3://recordings/competing/manifest.json",
    );
    second.beginTranscription();

    const results = await Promise.allSettled([
      repository.save(first.toSnapshot(), 0),
      repository.save(second.toSnapshot(), 0),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        conflict: {
          actualRevision: 1,
          expectedRevision: 0,
          kind: "revision-mismatch",
        },
      },
      status: "rejected",
    });
  });

  it("distinguishes a missing row from a stale revision", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const missing = recordedMeeting("meeting-missing");
    missing.beginTranscription();

    await expect(repository.save(missing.toSnapshot(), 0)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MeetingPersistenceConflictError &&
        error.conflict.kind === "meeting-not-found",
    );
  });

  it("returns null when the meeting is absent", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    expect(await repository.findById("unknown-meeting")).toBeNull();
  });

  it("rejects revision regression before opening a transaction", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const snapshot: MeetingSnapshot = recordedMeeting().toSnapshot();

    await expect(repository.save(snapshot, 1)).rejects.toThrow(
      "snapshot revision cannot be older than expectedRevision",
    );
  });
});
