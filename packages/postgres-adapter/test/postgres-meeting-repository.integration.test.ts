import {
  GuildConfiguration,
} from "@discord-meeting/guild-configuration-core";
import {
  EvidenceBackedSummary,
  FinalTranscript,
  LiveMeeting,
  Meeting,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type TestContext,
} from "vitest";

import {
  MeetingPersistenceConflictError,
  PostgresGuildConfigurationRepository,
  PostgresLiveMeetingRepository,
  PostgresMeetingRepository,
} from "../src/index.js";

const POSTGRES_IMAGE = "postgres:18.4-alpine";
const POSTGRES_PORT = 5432;

let container: StartedTestContainer | undefined;
let pool: Pool | undefined;
let dockerUnavailableReason: string | undefined;

function recordedMeeting(
  meetingId = "meeting-postgres-1",
  manifestLocator = "s3://recordings/meeting-postgres-1/manifest.json",
): Meeting {
  return Meeting.record({
    meetingId,
    publicationTargetId: "discord-channel-1",
    recording: {
      manifestLocator,
      recordingId: `recording-${meetingId}`,
      speakerAudio: [
        {
          audioLocator: `s3://recordings/${meetingId}/speaker-a.flac`,
          speakerId: "speaker-a",
          timelineOffsetMs: 0,
        },
        {
          audioLocator: `s3://recordings/${meetingId}/speaker-b.flac`,
          speakerId: "speaker-b",
          timelineOffsetMs: 650,
        },
      ],
    },
  });
}

function configuredGuild(): GuildConfiguration {
  return GuildConfiguration.configure({
    configuredByUserId: "11111111111111111",
    guildId: "22222222222222222",
    resultsChannelId: "33333333333333333",
    voiceChannelId: "44444444444444444",
  });
}

function evidenceBackedMeeting(meetingId = "meeting-postgres-1"): Meeting {
  const meeting = recordedMeeting(meetingId);
  meeting.beginTranscription();
  const transcript = FinalTranscript.create({
    recordingId: meeting.recording.recordingId,
    transcriptId: `transcript-${meetingId}`,
    turns: [
      {
        endMs: 1_400,
        speakerId: "speaker-a",
        startMs: 0,
        text: "We will ship the first release on Friday.",
        turnId: "turn-decision",
      },
      {
        endMs: 2_200,
        speakerId: "speaker-b",
        startMs: 900,
        text: "I will prepare the release checklist.",
        turnId: "turn-action",
      },
    ],
    version: 1,
  });
  meeting.completeTranscription(transcript);
  meeting.beginSummary();
  meeting.completeSummary(
    EvidenceBackedSummary.create(
      {
        actionItems: [
          {
            actionItemId: "action-checklist",
            evidenceTurnIds: ["turn-action"],
            ownerSpeakerId: "speaker-b",
            text: "Prepare the release checklist.",
          },
        ],
        decisions: [
          {
            decisionId: "decision-release-date",
            evidenceTurnIds: ["turn-decision"],
            text: "Ship the first release on Friday.",
          },
        ],
        openQuestions: [
          {
            evidenceTurnIds: ["turn-action"],
            id: "question-final-deployment",
            text: "Who runs the final deployment?",
          },
        ],
        overview: "The speakers agreed on the first release plan.",
        summaryId: `summary-${meetingId}`,
        title: "First release planning",
        transcriptId: transcript.transcriptId,
        version: 1,
      },
      transcript,
    ),
  );
  return meeting;
}

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
}

function isDockerUnavailable(error: unknown): boolean {
  const message = errorChain(error).toLowerCase();
  return (
    message.includes("could not find a working container runtime strategy") ||
    message.includes("cannot connect to the docker daemon") ||
    message.includes("docker.sock") &&
      (message.includes("enoent") ||
        message.includes("econnrefused") ||
        message.includes("eacces"))
  );
}

function databaseOrSkip(context: TestContext): Pool {
  if (pool !== undefined) {
    return pool;
  }

  context.skip(
    `Docker unavailable; disposable PostgreSQL integration test skipped: ${dockerUnavailableReason ?? "container runtime not initialized"}`,
  );
}

beforeAll(async () => {
  try {
    container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_DB: "meeting_test",
        POSTGRES_PASSWORD: "meeting_test_password",
        POSTGRES_USER: "meeting_test",
      })
      .withExposedPorts(POSTGRES_PORT)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/u, 2),
      )
      .withStartupTimeout(120_000)
      .start();

    pool = new Pool({
      connectionTimeoutMillis: 10_000,
      database: "meeting_test",
      host: container.getHost(),
      password: "meeting_test_password",
      port: container.getMappedPort(POSTGRES_PORT),
      user: "meeting_test",
    });
    await pool.query("SELECT 1");
    const migration = await readFile(
      new URL(
        "../../../infra/postgres/migrations/0001_create_meeting_core.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await pool.query(migration);
    const liveMigration = await readFile(
      new URL(
        "../../../infra/postgres/migrations/0003_create_live_meetings.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await pool.query(liveMigration);
    const guildConfigurationMigration = await readFile(
      new URL(
        "../../../infra/postgres/migrations/0004_create_guild_installations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await pool.query(guildConfigurationMigration);
  } catch (error) {
    if (!isDockerUnavailable(error)) {
      throw error;
    }
    dockerUnavailableReason = errorChain(error).slice(0, 300);
  }
}, 150_000);

beforeEach(async () => {
  if (pool !== undefined) {
    await pool.query(
      "TRUNCATE TABLE guild_configuration.guild_installations, meeting_core.live_meetings, meeting_core.post_call_outbox, meeting_core.meetings",
    );
  }
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

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("PostgresMeetingRepository", () => {
  it("atomically records a meeting and a recoverable post-call outbox item", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const snapshot = recordedMeeting("meeting-outbox-1").toSnapshot();

    await repository.recordAndSchedule(snapshot, 0);
    await repository.recordAndSchedule(snapshot, 0);
    expect(await repository.listPendingPostCall()).toEqual([
      { meetingId: snapshot.meetingId, schemaVersion: 1 },
    ]);

    await repository.markPostCallDispatched(snapshot.meetingId);
    expect(await repository.listPendingPostCall()).toEqual([]);
    expect(await repository.findById(snapshot.meetingId)).toEqual(snapshot);
  });

  it("accepts a finalized-ingress replay after post-call processing advanced the meeting", async (context) => {
    const database = databaseOrSkip(context);
    const repository = new PostgresMeetingRepository(database);
    const initial = recordedMeeting("meeting-ready-replay").toSnapshot();
    await repository.recordAndSchedule(initial, 0);

    const processed = evidenceBackedMeeting("meeting-ready-replay").toSnapshot();
    await repository.save(processed, 0);
    await repository.markPostCallDispatched(initial.meetingId);

    await expect(repository.recordAndSchedule(initial, 0)).resolves.toBeUndefined();
    expect(await repository.findById(initial.meetingId)).toEqual(processed);
    expect(await repository.listPendingPostCall()).toEqual([]);
  });

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

describe("PostgresLiveMeetingRepository", () => {
  it("round-trips live state with create and revision CAS semantics", async (context) => {
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
    meeting.appendFinalTurn({
      endMs: 15_000,
      speakerId: "speaker-a",
      startMs: 11_000,
      text: "Выпускаем версию в пятницу.",
      turnId: "turn-live-1",
    });
    const updated = meeting.toSnapshot();
    await repository.save(updated, initial.revision);
    await repository.save(updated, initial.revision);

    expect(await repository.findById(meeting.meetingId)).toEqual(updated);
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
    meeting.appendFinalTurn({
      endMs: 2_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Первая реплика.",
      turnId: "turn-live-1",
    });
    await repository.save(meeting.toSnapshot(), initial.revision);
    const competing = LiveMeeting.restore(initial);
    competing.appendFinalTurn({
      endMs: 3_000,
      speakerId: "speaker-b",
      startMs: 2_000,
      text: "Конкурирующая реплика.",
      turnId: "turn-live-2",
    });

    await expect(repository.save(competing.toSnapshot(), initial.revision)).rejects.toBeInstanceOf(
      MeetingPersistenceConflictError,
    );
  });
});
