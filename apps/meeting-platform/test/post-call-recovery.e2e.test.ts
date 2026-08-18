import {
  BullMqPostCallDeadLetterRecorder,
  BullMqPostCallEnqueuer,
  CompositePostCallDeadLetterRecorder,
  createPostCallDeadLetterQueue,
  createPostCallQueue,
  createPostCallQueueEvents,
  createPostCallWorker,
  drainActivePostCallJobsAndClose,
  postCallJobId,
} from "@discord-meeting/bullmq-adapter";
import type {
  GeneratedSummary,
  SummaryGenerationPort,
  SummaryGenerationRequest,
} from "@discord-meeting/meeting-core/meeting-intelligence";
import {
  Meeting,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core/meeting-lifecycle";
import { ProcessMeetingSummary } from "@discord-meeting/meeting-core/post-call-workflow";
import type {
  SummaryPublicationPort,
  SummaryPublicationRequest,
} from "@discord-meeting/meeting-core/publishing";
import type {
  FinalTranscriptionPort,
  FinalTranscriptionRequest,
  GeneratedTranscript,
} from "@discord-meeting/meeting-core/transcription";
import type {
  Logger,
  PrometheusMetrics,
} from "@discord-meeting/observability-adapter";
import {
  PostgresMeetingRepository,
  PostgresMigrationRunner,
  PostgresTranscriptionExecutionBindingStore,
} from "@discord-meeting/postgres-adapter";
import { Pool } from "pg";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type TestContext,
} from "vitest";

import { PostCallOutboxDispatcher } from "../src/application/post-call-outbox-dispatcher.js";
import {
  createPostCallBindingAdmission,
  createPostCallHandler,
} from "../src/composition/post-call.js";

const POSTGRES_IMAGE = "postgres:18.4-alpine";
const POSTGRES_PORT = 5_432;
const REDIS_IMAGE =
  "redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb";
const REDIS_PORT = 6_379;
const meetingId = "meeting-post-call-recovery-e2e";

let postgres: StartedTestContainer | undefined;
let redis: StartedTestContainer | undefined;
let database: Pool | undefined;
let dockerUnavailableReason: string | undefined;

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
  return message.includes("could not find a working container runtime strategy")
    || message.includes("cannot connect to the docker daemon")
    || (message.includes("docker.sock") && (
      message.includes("enoent")
      || message.includes("econnrefused")
      || message.includes("eacces")
    ));
}

function infrastructureOrSkip(context: TestContext): {
  readonly database: Pool;
  readonly postgres: StartedTestContainer;
  readonly redis: StartedTestContainer;
} {
  if (database !== undefined && postgres !== undefined && redis !== undefined) {
    return { database, postgres, redis };
  }
  context.skip(
    `Docker unavailable; recovery E2E skipped: ${dockerUnavailableReason ?? "unknown"}`,
  );
}

beforeAll(async () => {
  try {
    [postgres, redis] = await Promise.all([
      new GenericContainer(POSTGRES_IMAGE)
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
        .start(),
      new GenericContainer(REDIS_IMAGE)
        .withCommand([
          "redis-server",
          "--appendonly",
          "no",
          "--save",
          "",
          "--maxmemory-policy",
          "noeviction",
        ])
        .withExposedPorts(REDIS_PORT)
        .withStartupTimeout(120_000)
        .start(),
    ]);
    database = new Pool({
      database: "meeting_test",
      host: postgres.getHost(),
      password: "meeting_test_password",
      port: postgres.getMappedPort(POSTGRES_PORT),
      user: "meeting_test",
    });
    await new PostgresMigrationRunner(database).migrate();
  } catch (error) {
    if (!isDockerUnavailable(error)) {
      throw error;
    }
    dockerUnavailableReason = errorChain(error).slice(0, 300);
  }
}, 150_000);

afterAll(async () => {
  await database?.end();
  await Promise.all([postgres?.stop(), redis?.stop()]);
});

describe("post-call retryable recovery E2E", () => {
  it("resumes from the saved transcript and publishes exactly once", async (context) => {
    const infrastructure = infrastructureOrSkip(context);
    const repository = new PostgresMeetingRepository(infrastructure.database);
    const bindings = new PostgresTranscriptionExecutionBindingStore(infrastructure.database);
    const supportedBindings = new Set(["voicetext-batch-v2:deepgram-nova-3"]);
    await repository.recordAndSchedule(
      initialMeeting(),
      0,
      "voicetext-batch-v2:deepgram-nova-3",
    );

    const connection = {
      host: infrastructure.redis.getHost(),
      port: infrastructure.redis.getMappedPort(REDIS_PORT),
    };
    const prefix = "post-call-recovery-e2e";
    const queuePolicy = {
      attempts: 2,
      backoffDelayMs: 10,
      backoffJitter: 0,
    };
    const queue = createPostCallQueue({ connection, prefix, ...queuePolicy });
    const deadLetterQueue = createPostCallDeadLetterQueue({ connection, prefix });
    const queueEvents = createPostCallQueueEvents({ connection, prefix });
    const ledger = {
      record: async (record: Parameters<typeof repository.settlePostCallFailure>[0]) => {
        await repository.settlePostCallFailure(record);
      },
    };
    const deadLetters = new CompositePostCallDeadLetterRecorder(
      ledger,
      new BullMqPostCallDeadLetterRecorder(deadLetterQueue),
    );
    const transcriber = new SuccessfulTranscriber();
    const summarizer = new RecoveringSummarizer();
    const publisher = new CapturingPublisher();
    const processMeeting = new ProcessMeetingSummary({
      meetings: repository,
      publisher,
      summarizer,
      transcriber,
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger;
    const metrics = {
      recordDiscordPublication: vi.fn(),
    } as unknown as PrometheusMetrics;
    const worker = createPostCallWorker({
      admission: createPostCallBindingAdmission(bindings, supportedBindings),
      connection,
      deadLetterRecorder: deadLetters,
      handler: createPostCallHandler(processMeeting, repository, logger, metrics),
      prefix,
      ...queuePolicy,
    });
    const dispatcher = new PostCallOutboxDispatcher(
      repository,
      new BullMqPostCallEnqueuer(queue, queuePolicy),
      deadLetters,
      logger,
      {
        store: bindings,
        values: {
          legacyRecovery: "voicetext-batch-v2:deepgram-nova-3",
          supported: supportedBindings,
        },
      },
    );

    try {
      await Promise.all([
        queue.waitUntilReady(),
        deadLetterQueue.waitUntilReady(),
        queueEvents.waitUntilReady(),
        worker.waitUntilReady(),
      ]);

      await expect(dispatcher.dispatchPending()).resolves.toEqual({
        dispatched: 1,
        failed: 0,
      });
      const initialJob = await queue.getJob(postCallJobId(meetingId));
      expect(initialJob).toBeDefined();
      await expect(initialJob!.waitUntilFinished(queueEvents, 10_000)).rejects.toThrow(
        "SUBSCRIPTION_RUNTIME_SUMMARY_TRANSPORT_UNAVAILABLE",
      );
      await worker.waitForActivePostCallJobs();

      expect(transcriber.requests).toHaveLength(1);
      expect(summarizer.requests).toHaveLength(2);
      expect(publisher.requests).toHaveLength(0);
      expect(await repository.listRecoverablePostCall(100, supportedBindings)).toEqual([]);

      await infrastructure.database.query(`
        UPDATE meeting_core.post_call_outbox
        SET binding_recovery_after = transaction_timestamp() - interval '1 second'
        WHERE meeting_id = $1
      `, [meetingId]);
      await expect(dispatcher.dispatchPending()).resolves.toEqual({
        dispatched: 1,
        failed: 0,
      });

      const recoveryJob = await queue.getJob(postCallJobId(meetingId, 1));
      expect(recoveryJob).toBeDefined();
      await expect(
        recoveryJob!.waitUntilFinished(queueEvents, 10_000),
      ).resolves.toBeNull();
      await worker.waitForActivePostCallJobs();

      expect(transcriber.requests).toHaveLength(1);
      expect(summarizer.requests).toHaveLength(3);
      expect(publisher.requests).toHaveLength(1);
      expect(await repository.listRecoverablePostCall(100, supportedBindings)).toEqual([]);
      await expect(dispatcher.dispatchPending()).resolves.toEqual({
        dispatched: 0,
        failed: 0,
      });
      expect(publisher.requests).toHaveLength(1);

      const persisted = await repository.findById(meetingId);
      expect(persisted?.transcript?.transcriptId).toBe("transcript-recovery-e2e");
      expect(persisted?.publication?.externalPublicationId).toBe(
        "discord-message-recovery-e2e",
      );
      const receipt = await infrastructure.database.query<{
        readonly dead_lettered: boolean;
        readonly processed: boolean;
        readonly recovery_generation: number;
      }>(`
        SELECT dead_lettered_at IS NOT NULL AS dead_lettered,
               processed_at IS NOT NULL AS processed,
               recovery_generation::float8 AS recovery_generation
        FROM meeting_core.post_call_outbox
        WHERE meeting_id = $1
      `, [meetingId]);
      expect(receipt.rows).toEqual([{
        dead_lettered: false,
        processed: true,
        recovery_generation: 1,
      }]);
    } finally {
      await drainActivePostCallJobsAndClose({
        queueEvents,
        queues: [queue, deadLetterQueue],
        worker,
      });
    }
  }, 30_000);
});

const transcript: GeneratedTranscript = {
  transcriptId: "transcript-recovery-e2e",
  turns: [{
    endMs: 1_000,
    speakerId: "speaker-a",
    startMs: 0,
    text: "Ship the recovery fix.",
    turnId: "turn-recovery-e2e",
  }],
  version: 1,
};

const summary: GeneratedSummary = {
  actionItems: [],
  decisions: [{
    decisionId: "decision-recovery-e2e",
    evidenceTurnIds: ["turn-recovery-e2e"],
    text: "Ship the recovery fix.",
  }],
  openQuestions: [],
  overview: "The retryable post-call flow recovered.",
  summaryId: "summary-recovery-e2e",
  title: "Recovery verification",
  topics: [{
    evidenceTurnIds: ["turn-recovery-e2e"],
    points: ["The durable recovery generation completed."],
    title: "Post-call recovery",
  }],
  version: 1,
};

class SuccessfulTranscriber implements FinalTranscriptionPort {
  public readonly requests: FinalTranscriptionRequest[] = [];

  public transcribe(request: FinalTranscriptionRequest) {
    this.requests.push(structuredClone(request));
    return Promise.resolve({ ok: true as const, value: transcript });
  }
}

class RecoveringSummarizer implements SummaryGenerationPort {
  public readonly requests: SummaryGenerationRequest[] = [];

  public generate(request: SummaryGenerationRequest) {
    this.requests.push(structuredClone(request));
    if (this.requests.length <= 2) {
      return Promise.resolve({
        failure: {
          code: "SUBSCRIPTION_RUNTIME_SUMMARY_TRANSPORT_UNAVAILABLE",
          message: "synthetic provider outage",
          retryable: true,
        },
        ok: false as const,
      });
    }
    return Promise.resolve({ ok: true as const, value: summary });
  }
}

class CapturingPublisher implements SummaryPublicationPort {
  public readonly requests: SummaryPublicationRequest[] = [];

  public publish(request: SummaryPublicationRequest) {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      ok: true as const,
      value: { externalPublicationId: "discord-message-recovery-e2e" },
    });
  }
}

function initialMeeting(): MeetingSnapshot {
  return Meeting.record({
    meetingId,
    publicationTargetId: "test-results-channel",
    recording: {
      manifestLocator: "recordings/recovery-e2e/manifest.json",
      recordingId: "recording-recovery-e2e",
      speakerAudio: [{
        audioLocator: "recordings/recovery-e2e/speaker-a.ogg",
        speakerId: "speaker-a",
        timelineOffsetMs: 0,
      }],
    },
  }).toSnapshot();
}
