import { createHash } from "node:crypto";

import { GuildConfiguration } from "@discord-meeting/guild-configuration-core";
import {
  createHistoricalReleaseBinding,
  DEFAULT_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS,
  DEFAULT_HISTORICAL_SYNC_POLICY,
  HistoricalSyncWorker,
  historicalSyncLeaseDurationMs,
  MAXIMUM_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS,
  type HistoricalMemoryPort,
  type HistoricalOpaqueIdPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  Meeting,
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
  PostgresHistoricalEvidenceAuthority,
  PostgresHistoricalMemoryStore,
  PostgresMeetingRepository,
  PostgresSummaryPublicationEffectLedger,
} from "../src/index.js";

usePostgresIntegrationDatabase();

class DeterministicHistoricalTestIds implements HistoricalOpaqueIdPort {
  public keyedId(namespace: string, parts: readonly string[]): string {
    return createHash("sha256")
      .update([namespace, ...parts].join("\u0000"), "utf8")
      .digest("hex");
  }
}

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

const selectedBinding = "voicetext-batch-v3:elevenlabs-scribe-v2";
const selectedBindings = new Set([selectedBinding]);

describe("PostgresMeetingRepository", () => {
  it("claims index and deletion work at the default and maximum composed lease", async (context) => {
    const database = databaseOrSkip(context);
    const leases = [
      historicalSyncLeaseDurationMs(DEFAULT_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS),
      historicalSyncLeaseDurationMs(MAXIMUM_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS),
    ];

    for (const [index, leaseDurationMs] of leases.entries()) {
      const meetingId = `meeting-historical-lease-${String(index)}`;
      const repository = new PostgresMeetingRepository(database);
      await repository.recordAndSchedule(recordedMeeting(meetingId).toSnapshot(), 0, selectedBinding);
      await repository.save(evidenceBackedMeeting(meetingId).toSnapshot(), 0);
      const store = new PostgresHistoricalMemoryStore(database);
      const indexLease = await store.claimNext({ allowIndex: true, leaseDurationMs });
      expect(indexLease).toMatchObject({ operation: "index" });
      if (indexLease === null) {
        throw new Error("historical index lease was not claimed");
      }
      await store.recordRetry(indexLease, {
        code: "fixture.known_failure",
        outcome: "known_failure",
        retryAfterMs: 0,
      });
      await store.requestMeetingDeletion(meetingId);
      const deleteLease = await store.claimNext({ allowIndex: false, leaseDurationMs });
      expect(deleteLease).toMatchObject({ operation: "delete_meeting" });
      if (deleteLease === null) {
        throw new Error("historical deletion lease was not claimed");
      }
      await store.recordDeleted(deleteLease);
    }
  });

  it("quarantines an unknown index outcome until late commit cleanup after restart", async (context) => {
    const database = databaseOrSkip(context);
    const meetingId = "meeting-historical-unknown-outcome";
    const repository = new PostgresMeetingRepository(database);
    await repository.recordAndSchedule(recordedMeeting(meetingId).toSnapshot(), 0, selectedBinding);
    await repository.save(evidenceBackedMeeting(meetingId).toSnapshot(), 0);

    let remoteCommitted = false;
    let deletionCalls = 0;
    const memory: HistoricalMemoryPort = {
      deleteMeeting: async () => {
        deletionCalls += 1;
        expect(remoteCommitted).toBe(true);
        remoteCommitted = false;
        return { status: "verified_absent" };
      },
      indexFinalMeeting: async () => ({
        code: "memory.ingest_timeout",
        // Retryability cannot decide whether an uncertain remote write needs
        // quarantine: invalid response bytes may follow a committed request.
        retryable: false,
        status: "outcome_unknown",
      }),
      searchRoom: async () => ({
        code: "fixture.unused",
        retryable: false,
        status: "unavailable",
      }),
    };
    const ids = new DeterministicHistoricalTestIds();
    const store = new PostgresHistoricalMemoryStore(database);
    const worker = new HistoricalSyncWorker({
      authority: new PostgresHistoricalEvidenceAuthority(database),
      ids,
      memory,
      store,
    }, {
      ...DEFAULT_HISTORICAL_SYNC_POLICY,
      leaseDurationMs: 30_000,
      retryBackoffMs: [1],
    });

    await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      operation: "index",
      status: "retry_scheduled",
    });
    await store.requestMeetingDeletion(meetingId);
    const quarantined = await database.query<{
      readonly lease_active: boolean;
      readonly operation: string;
      readonly state: string;
    }>(
      `
        SELECT lease_expires_at > transaction_timestamp() AS lease_active,
               operation, state
        FROM meeting_core.historical_memory_sync
        WHERE meeting_id = $1
      `,
      [meetingId],
    );
    expect(quarantined.rows[0]).toEqual({
      lease_active: true,
      operation: "delete_meeting",
      state: "in_flight",
    });

    const restarted = new HistoricalSyncWorker({
      authority: new PostgresHistoricalEvidenceAuthority(database),
      ids,
      memory,
      store: new PostgresHistoricalMemoryStore(database),
    }, {
      ...DEFAULT_HISTORICAL_SYNC_POLICY,
      leaseDurationMs: 30_000,
      retryBackoffMs: [1],
    });
    await expect(restarted.executeOnce({ indexingEnabled: false })).resolves.toEqual({
      status: "idle",
    });
    expect(deletionCalls).toBe(0);

    // The provider commits after the caller has timed out. The retained fence
    // keeps deletion from proving absence until that uncertainty horizon ends.
    remoteCommitted = true;
    await database.query(
      `
        UPDATE meeting_core.historical_memory_sync
        SET lease_expires_at = transaction_timestamp()
        WHERE meeting_id = $1
      `,
      [meetingId],
    );
    await expect(restarted.executeOnce({ indexingEnabled: false })).resolves.toMatchObject({
      operation: "delete_meeting",
      status: "deleted",
    });
    expect(deletionCalls).toBe(1);
    expect(remoteCommitted).toBe(false);
    await expect(database.query<{ readonly state: string }>(
      "SELECT state FROM meeting_core.historical_memory_sync WHERE meeting_id = $1",
      [meetingId],
    )).resolves.toMatchObject({ rows: [{ state: "deleted" }] });
  });

  it("transactionally projects one replay-safe final human transcript release", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const initial = recordedMeeting("meeting-historical-release").toSnapshot();
    await repository.recordAndSchedule(initial, 0, selectedBinding);
    const accepted = evidenceBackedMeeting("meeting-historical-release").toSnapshot();

    await repository.save(accepted, 0);
    await repository.save(accepted, 0);

    const store = new PostgresHistoricalMemoryStore(database);
    const bindings = await store.listDesiredRoomBindings("scope-1", "room-1", 100);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      acceptedMeetingRevision: 4,
      desiredGeneration: 1,
      meetingId: "meeting-historical-release",
      transcriptVersion: 1,
    });
    const authority = new PostgresHistoricalEvidenceAuthority(database);
    const release = await authority.loadAcceptedFinalMeeting(bindings[0]!);
    expect(release?.humanTurns.map(({ speakerId }) => speakerId)).toEqual([
      "speaker-a",
      "speaker-b",
      "speaker-a",
    ]);
    await expect(store.acceptRelease(createHistoricalReleaseBinding({
      acceptedMeetingRevision: 4,
      desiredGeneration: 1,
      meetingId: accepted.meetingId,
      roomId: "conflicting-room",
      scopeId: "scope-1",
      transcriptId: bindings[0]!.transcriptId,
      transcriptVersion: 1,
    }))).rejects.toThrow("conflicts with its accepted binding");
    await expect(store.acceptRelease(createHistoricalReleaseBinding({
      acceptedMeetingRevision: 5,
      desiredGeneration: 3,
      meetingId: accepted.meetingId,
      roomId: "room-1",
      scopeId: "scope-1",
      transcriptId: "skipped-generation-transcript",
      transcriptVersion: 2,
    }))).rejects.toThrow("next monotonic generation");

    expect(await store.claimNext({ allowIndex: false, leaseDurationMs: 30_000 }))
      .toBeNull();
    await store.requestMeetingDeletion(accepted.meetingId);
    await expect(store.acceptRelease(createHistoricalReleaseBinding({
      acceptedMeetingRevision: 5,
      desiredGeneration: 2,
      meetingId: accepted.meetingId,
      roomId: "room-1",
      scopeId: "scope-1",
      transcriptId: "replacement-after-withdrawal",
      transcriptVersion: 2,
    }))).rejects.toThrow("withdrawn meeting");
    const deletion = await store.claimNext({ allowIndex: false, leaseDurationMs: 30_000 });
    expect(deletion).toMatchObject({ operation: "delete_meeting" });
  });

  it("retains an active index lease when a newer generation supersedes it", async (context) => {
    const database = databaseOrSkip(context);
    const meetingId = "meeting-historical-in-flight-supersession";
    const repository = new PostgresMeetingRepository(database);
    await repository.recordAndSchedule(recordedMeeting(meetingId).toSnapshot(), 0, selectedBinding);
    await repository.save(evidenceBackedMeeting(meetingId).toSnapshot(), 0);
    const store = new PostgresHistoricalMemoryStore(database);
    const [first] = await store.listDesiredRoomBindings("scope-1", "room-1", 100);
    if (first === undefined) {
      throw new Error("historical supersession fixture has no first generation");
    }
    await expect(store.claimNext({ allowIndex: true, leaseDurationMs: 30_000 }))
      .resolves.toMatchObject({ operation: "index" });

    await store.acceptRelease(createHistoricalReleaseBinding({
      acceptedMeetingRevision: first.acceptedMeetingRevision + 1,
      desiredGeneration: 2,
      meetingId,
      roomId: first.roomId,
      scopeId: first.scopeId,
      transcriptId: "replacement-in-flight-transcript",
      transcriptVersion: 2,
    }));

    const superseded = await database.query<{
      readonly lease_active: boolean;
      readonly operation: string;
      readonly state: string;
    }>(
      `
        SELECT lease_expires_at > transaction_timestamp() AS lease_active,
               operation, state
        FROM meeting_core.historical_memory_sync
        WHERE release_id = $1
      `,
      [first.releaseId],
    );
    expect(superseded.rows[0]).toEqual({
      lease_active: true,
      operation: "delete_release",
      state: "in_flight",
    });
    await expect(store.claimNext({ allowIndex: false, leaseDurationMs: 30_000 }))
      .resolves.toBeNull();
  });
});

describe("PostgresMeetingRepository post-call durability", () => {
  it("keeps an enqueued post-call item recoverable until a durable processing receipt", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const snapshot = recordedMeeting("meeting-outbox-1").toSnapshot();

    await repository.recordAndSchedule(snapshot, 0, selectedBinding);
    await repository.recordAndSchedule(snapshot, 0, selectedBinding);
    expect(await repository.listRecoverablePostCall(100, selectedBindings)).toEqual([
      { meetingId: snapshot.meetingId, recoveryGeneration: 0, schemaVersion: 1 },
    ]);

    await repository.markPostCallEnqueued(snapshot.meetingId);
    expect(await repository.listRecoverablePostCall(100, selectedBindings)).toEqual([
      { meetingId: snapshot.meetingId, recoveryGeneration: 0, schemaVersion: 1 },
    ]);
    await repository.markPostCallProcessed(snapshot.meetingId);
    expect(await repository.listRecoverablePostCall(100, selectedBindings)).toEqual([]);
    expect(await repository.findById(snapshot.meetingId)).toEqual(snapshot);
  });

  it("accepts a finalized-ingress replay after post-call processing advanced the meeting", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const initial = recordedMeeting("meeting-ready-replay").toSnapshot();
    await repository.recordAndSchedule(initial, 0, selectedBinding);

    const processed = evidenceBackedMeeting("meeting-ready-replay").toSnapshot();
    await repository.save(processed, 0);
    await repository.markPostCallProcessed(initial.meetingId);

    await expect(repository.recordAndSchedule(initial, 0, selectedBinding)).resolves.toBeUndefined();
    expect(await repository.findById(initial.meetingId)).toEqual(processed);
    expect(await repository.listRecoverablePostCall(100, selectedBindings)).toEqual([]);
  });

  it("accepts an old v1 completion replay without enriching a pre-upgrade snapshot", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const current = recordedMeeting("meeting-v1-upgrade-replay").toSnapshot();
    const {
      actors: _actors,
      identityProvenance: _identityProvenance,
      lifecycleGeneration: _lifecycleGeneration,
      source: _source,
      ...preUpgradeSnapshot
    } = current;
    await database.query(
      `
        INSERT INTO meeting_core.meetings (meeting_id, revision, snapshot)
        VALUES ($1, 0, $2::jsonb)
      `,
      [current.meetingId, preUpgradeSnapshot],
    );
    const replay = Meeting.recordLegacy({
      lifecycleGeneration: 1,
      meetingId: current.meetingId,
      publicationTargetId: current.publicationTargetId,
      recording: current.recording,
      source: current.source,
    }).toSnapshot();

    await expect(repository.recordAndSchedule(replay, 0, selectedBinding)).resolves.toBeUndefined();
    expect(await repository.findById(current.meetingId)).toMatchObject({
      actors: null,
      identityProvenance: null,
      lifecycleGeneration: null,
      source: null,
    });
    const stored = await database.query<{ readonly snapshot: Record<string, unknown> }>(
      "SELECT snapshot FROM meeting_core.meetings WHERE meeting_id = $1",
      [current.meetingId],
    );
    expect(stored.rows[0]?.snapshot).toEqual(preUpgradeSnapshot);
    expect(stored.rows[0]?.snapshot).not.toHaveProperty("identityProvenance");
    expect(stored.rows[0]?.snapshot).not.toHaveProperty("lifecycleGeneration");
  });

  it("rejects finalized-ingress replays with changed source or actor identity", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const variants = [
      {
        change: (snapshot: MeetingSnapshot): MeetingSnapshot => ({
          ...snapshot,
          source: { roomId: "different-room", scopeId: snapshot.source?.scopeId ?? "scope-1" },
        }),
        meetingId: "meeting-source-conflict",
      },
      {
        change: (snapshot: MeetingSnapshot): MeetingSnapshot => ({
          ...snapshot,
          actors: snapshot.actors?.map((actor, index) => index === 0
            ? { ...actor, kind: "automation" as const }
            : actor) ?? null,
        }),
        meetingId: "meeting-actor-conflict",
      },
      {
        change: (snapshot: MeetingSnapshot): MeetingSnapshot => ({
          ...snapshot,
          identityProvenance: {
            actorObservationState: "consistent",
            actorSemanticsVersion: 1,
            producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
            producerRevision: "fedcba9876543210fedcba9876543210fedcba98",
            rosterState: "sealed",
          },
          lifecycleGeneration: 3,
        }),
        meetingId: "meeting-generation-conflict",
      },
    ] as const;

    for (const variant of variants) {
      const original = recordedMeeting(variant.meetingId).toSnapshot();
      await repository.recordAndSchedule(original, 0, selectedBinding);

      await expect(repository.recordAndSchedule(variant.change(original), 0, selectedBinding))
        .rejects.toMatchObject({
          code: "MEETING_PERSISTENCE_CONFLICT",
          conflict: { kind: "meeting-already-exists", meetingId: variant.meetingId },
        });
    }
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
    await repository.recordAndSchedule(snapshot, 0, selectedBinding);
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
    expect(await repository.listRecoverablePostCall(100, selectedBindings)).toEqual([]);
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
    await repository.recordAndSchedule(snapshot, 0, selectedBinding);

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
    await repository.recordAndSchedule(snapshot, 0, selectedBinding);
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
    expect(await repository.listRecoverablePostCall(100, selectedBindings)).toEqual([]);

    const scheduled = await database.query<{
      readonly delay_seconds: number;
      readonly recovery_generation: number;
      readonly recovery_source_job_ref: string;
    }>(`
      SELECT recovery_generation::float8 AS recovery_generation,
             recovery_source_job_ref,
             EXTRACT(EPOCH FROM (binding_recovery_after - recorded_at))::float8 AS delay_seconds
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
      SET binding_recovery_after = transaction_timestamp() - interval '1 second'
      WHERE meeting_id = $1
    `, [snapshot.meetingId]);
    expect(await repository.listRecoverablePostCall(100, selectedBindings)).toEqual([{
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
             EXTRACT(EPOCH FROM (binding_recovery_after - transaction_timestamp()))::float8
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
    expect(restored?.transcript?.turns).toHaveLength(3);
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
