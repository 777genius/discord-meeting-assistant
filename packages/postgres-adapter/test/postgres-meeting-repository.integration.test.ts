import {
  EvidenceBackedSummary,
  FinalTranscript,
  Meeting,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  GenericContainer,
  type StartedTestContainer,
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
        openQuestions: ["Who runs the final deployment?"],
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
      "TRUNCATE TABLE meeting_core.post_call_outbox, meeting_core.meetings",
    );
  }
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
