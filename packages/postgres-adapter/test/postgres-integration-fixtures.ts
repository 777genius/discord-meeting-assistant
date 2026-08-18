import { GuildConfiguration } from "@discord-meeting/guild-configuration-core";
import {
  EvidenceBackedSummary,
} from "@discord-meeting/meeting-core/meeting-intelligence";
import {
  FinalTranscript,
  type TranscriptTurnSnapshot,
} from "@discord-meeting/meeting-core/transcription";
import {
  Meeting,
} from "@discord-meeting/meeting-core/meeting-lifecycle";
import {
  type LiveGenerationTelemetrySnapshot,
  type LiveGenerationUsageSnapshot,
  type LiveSummaryDraftSnapshot,
} from "@discord-meeting/meeting-core/live-meeting";
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
  type TestContext,
} from "vitest";

import { PostgresMigrationRunner } from "../src/index.js";

const POSTGRES_IMAGE = "postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const POSTGRES_PORT = 5432;

let container: StartedTestContainer | undefined;
let pool: Pool | undefined;
let dockerUnavailableReason: string | undefined;
let appendOnlyLiveMeetingMigration: string | undefined;
let externalConnectionString: string | undefined;
let meetingCoreMigration: string | undefined;
let liveMeetingsMigration: string | undefined;
let isolatedDatabaseSequence = 0;

export interface IsolatedPostgresDatabase {
  readonly dispose: () => Promise<void>;
  readonly pool: Pool;
}

export function usePostgresIntegrationDatabase(): void {
  beforeAll(async () => {
    const configuredDatabase = process.env.POSTGRES_INTEGRATION_DATABASE_URL;
    if (configuredDatabase !== undefined) {
      externalConnectionString = requireDisposableConnectionString(configuredDatabase);
      pool = new Pool({ connectionString: externalConnectionString });
      await initializeIntegrationDatabase(pool);
      return;
    }

    try {
      container = await new GenericContainer(POSTGRES_IMAGE)
        .withEnvironment({
          POSTGRES_DB: "meeting_test",
          POSTGRES_PASSWORD: "fixture",
          POSTGRES_USER: "meeting_test",
        })
        .withExposedPorts(POSTGRES_PORT)
        .withWaitStrategy(
          Wait.forLogMessage(/database system is ready to accept connections/u, 2),
        )
        .withStartupTimeout(120_000)
        .start();

      pool = new Pool(poolOptions("meeting_test"));
      await initializeIntegrationDatabase(pool);
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
        "TRUNCATE TABLE guild_configuration.guild_installations, meeting_core.conversation_one_shot_receipts, meeting_core.answer_effects, meeting_knowledge.current_question_policy, meeting_knowledge.question_rate_reservations, meeting_knowledge.question_jobs, meeting_knowledge.unavailable_final_projections, meeting_knowledge.withdrawn_meeting_sources, meeting_core.historical_coverage_checkpoints, meeting_core.historical_memory_sync, meeting_knowledge.live_memory_hot_tail, meeting_knowledge.live_memory_outbox, meeting_knowledge.live_memory_meetings, meeting_core.summary_publication_effects, meeting_core.post_call_dead_letters, meeting_core.live_meeting_summary_coverage, meeting_core.live_meeting_turns, meeting_core.live_meeting_generation_usage, meeting_core.live_meeting_generation_telemetry, meeting_core.live_meetings, meeting_core.post_call_outbox, meeting_core.meetings",
      );
    }
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });
}

export function databaseOrSkip(context: TestContext): Pool {
  if (pool !== undefined) {
    return pool;
  }

  context.skip(
    `Docker unavailable; disposable PostgreSQL integration test skipped: ${dockerUnavailableReason ?? "container runtime not initialized"}`,
  );
}

export function requiredAppendOnlyLiveMeetingMigration(): string {
  if (appendOnlyLiveMeetingMigration === undefined) {
    throw new Error("append-only live meeting migration was not loaded");
  }
  return appendOnlyLiveMeetingMigration;
}

export function requiredLegacyLiveMigrations(): {
  readonly liveMeetings: string;
  readonly meetingCore: string;
} {
  if (meetingCoreMigration === undefined || liveMeetingsMigration === undefined) {
    throw new Error("legacy live meeting migrations were not loaded");
  }
  return Object.freeze({
    liveMeetings: liveMeetingsMigration,
    meetingCore: meetingCoreMigration,
  });
}

export async function createIsolatedDatabase(): Promise<IsolatedPostgresDatabase> {
  const databaseName = `meeting_migration_${++isolatedDatabaseSequence}`;
  const admin = new Pool(poolOptions("postgres"));
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }
  const isolatedPool = new Pool(poolOptions(databaseName));
  return Object.freeze({
    dispose: async () => {
      await isolatedPool.end();
      const cleanup = new Pool(poolOptions("postgres"));
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
    pool: isolatedPool,
  });
}

export async function waitForTimelineReadToBlock(database: Pool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await database.query<{ readonly count: number }>(`
      SELECT count(*)::integer AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE '%meeting_core.live_meeting_turns%'
    `);
    if ((result.rows[0]?.count ?? 0) > 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("repeatable-read timeline query did not block on the controlled lock");
}

export function recordedMeeting(
  meetingId = "meeting-postgres-1",
  manifestLocator = "s3://recordings/meeting-postgres-1/manifest.json",
  publicationTargetId = "discord-channel-1",
): Meeting {
  return Meeting.record({
    actors: [
      { actorId: "speaker-a", kind: "human" },
      { actorId: "speaker-b", kind: "human" },
    ],
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "0123456789abcdef0123456789abcdef01234567",
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingId,
    publicationTargetId,
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
    source: { roomId: "room-1", scopeId: "scope-1" },
  });
}

export function configuredGuild(): GuildConfiguration {
  return GuildConfiguration.configure({
    configuredByUserId: "11111111111111111",
    guildId: "22222222222222222",
    resultsChannelId: "33333333333333333",
    voiceChannelId: "44444444444444444",
  });
}

export function finalizedLiveTurn(turnId = "turn-live-1"): TranscriptTurnSnapshot {
  return {
    endMs: 15_000,
    speakerId: "speaker-a",
    startMs: 11_000,
    text: "Выпускаем версию в пятницу.",
    turnId,
  };
}

export function liveGenerationUsage(runId = "usage-live-1"): LiveGenerationUsageSnapshot {
  return {
    apiEquivalentCostUsd: 0.000_042,
    cacheWriteInputTokens: 0,
    cachedInputTokens: 0,
    inputTokens: 30,
    model: "gpt-5.6-luna",
    outputTokens: 2,
    priceCard: "openai-standard-2026-08-02",
    reasoningOutputTokens: 0,
    runId,
    totalTokens: 32,
  };
}

export function liveGenerationTelemetry(
  runId = "telemetry-live-1",
): LiveGenerationTelemetrySnapshot {
  return {
    cacheWriteInputTokens: { availability: "unavailable" },
    cachedInputTokens: { availability: "measured", value: 4 },
    inputTokens: { availability: "measured", value: 30 },
    model: "gpt-5.6-luna",
    outputTokens: { availability: "measured", value: 2 },
    reasoningOutputTokens: { availability: "measured", value: 0 },
    runId,
    source: "integration-test",
    totalTokens: {
      availability: "derived",
      derivedFrom: ["inputTokens", "outputTokens"],
      value: 32,
    },
  };
}

export function liveSummary(
  evidenceTurnId: string,
  revision = 1,
): LiveSummaryDraftSnapshot {
  return {
    actionItems: [],
    decisions: [{
      decisionId: `decision-${revision}`,
      evidenceTurnIds: [evidenceTurnId],
      text: "Выпустить версию в пятницу.",
    }],
    openQuestions: [],
    overview: "Команда согласовала план выпуска.",
    revision,
    title: "План выпуска",
    topics: [{
      evidenceTurnIds: [evidenceTurnId],
      points: ["Версия выйдет в пятницу"],
      title: "Релиз",
    }],
  };
}

export function evidenceBackedMeeting(
  meetingId = "meeting-postgres-1",
  publicationTargetId = "discord-channel-1",
): Meeting {
  const meeting = recordedMeeting(
    meetingId,
    "s3://recordings/meeting-postgres-1/manifest.json",
    publicationTargetId,
  );
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
      {
        endMs: 3_200,
        speakerId: "speaker-a",
        startMs: 2_400,
        text: "The support rotation remains unchanged.",
        turnId: "turn-support-rotation",
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


async function initializeIntegrationDatabase(database: Pool): Promise<void> {
  await database.query("SELECT 1");
  meetingCoreMigration = await readFile(
    new URL(
      "../../../infra/postgres/migrations/0001_create_meeting_core.sql",
      import.meta.url,
    ),
    "utf8",
  );
  liveMeetingsMigration = await readFile(
    new URL(
      "../../../infra/postgres/migrations/0003_create_live_meetings.sql",
      import.meta.url,
    ),
    "utf8",
  );
  appendOnlyLiveMeetingMigration = await readFile(
    new URL(
      "../../../infra/postgres/migrations/0005_live_meeting_append_only.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await new PostgresMigrationRunner(database).migrate();
}

function requireDisposableConnectionString(value: string): string {
  const parsed = new URL(value);
  const databaseName = parsed.pathname.slice(1);
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !/^meeting_test_[a-z\d_]+$/u.test(databaseName)
  ) {
    throw new Error(
      "POSTGRES_INTEGRATION_DATABASE_URL must name a disposable meeting_test_* database",
    );
  }
  return parsed.toString();
}

function poolOptions(database: string): ConstructorParameters<typeof Pool>[0] {
  if (externalConnectionString !== undefined) {
    const parsed = new URL(externalConnectionString);
    parsed.pathname = `/${database}`;
    return {
      connectionString: parsed.toString(),
      connectionTimeoutMillis: 10_000,
    };
  }
  if (container === undefined) {
    throw new Error("PostgreSQL container is not initialized");
  }
  return {
    connectionTimeoutMillis: 10_000,
    database,
    host: container.getHost(),
    password: "fixture",
    port: container.getMappedPort(POSTGRES_PORT),
    user: "meeting_test",
  };
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
