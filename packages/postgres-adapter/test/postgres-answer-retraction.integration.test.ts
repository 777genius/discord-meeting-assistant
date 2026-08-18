import { createHash } from "node:crypto";

import {
  createFocusedRetrievalGroundingPlan,
  createHistoricalReleaseBinding,
} from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { describe, expect, it } from "vitest";

import {
  PostgresAnswerEffectStore,
  PostgresHistoricalMemoryStore,
  PostgresQuestionAdmissionCommit,
  PostgresQuestionJobStore,
} from "../src/index.js";
import {
  databaseOrSkip,
  evidenceBackedMeeting,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

const channelId = "22222222222222222";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function insertRunningQuestion(
  database: ReturnType<typeof databaseOrSkip>,
  input: {
    readonly meetingId: string;
    readonly projectionReceipt: string;
    readonly questionId: string;
    readonly sourceMeetingIds?: readonly string[];
  },
): Promise<void> {
  await database.query(
    `INSERT INTO meeting_knowledge.question_jobs (
       question_id, requester_subject, question_hash, scope_id,
       final_projection_receipt, authorization_principal_ref,
       authorization_digest, locale, question_text, binding, binding_hash,
       source_meeting_ids, state, generation, lease_owner, lease_until, expires_at
     ) VALUES (
       $1, $2, $3, 'scope-1', $4, 'opaque-principal',
       $5, 'en', 'Sensitive question?', $6::jsonb, $7,
       $8::text[], 'running', 1, 'worker-1',
       transaction_timestamp() + interval '1 minute',
       transaction_timestamp() + interval '10 minutes'
     )`,
    [
      input.questionId,
      "a".repeat(64),
      "b".repeat(64),
      input.projectionReceipt,
      "c".repeat(64),
      { meetingId: input.meetingId },
      "d".repeat(64),
      input.sourceMeetingIds ?? [],
    ],
  );
}

function groundingPlan(meetingId: string) {
  return createFocusedRetrievalGroundingPlan({
    authorityGeneration: `generation:${meetingId}`,
    coverage: "sufficient",
    humanActorIds: ["speaker-a"],
    turns: [{
      endMs: 1_000,
      speakerId: "speaker-a",
      startMs: 0,
      text: "Grounded evidence",
      turnHash: "e".repeat(64),
      turnId: "turn-1",
    }],
  });
}

async function waitForBlockedAnswerFence(
  database: ReturnType<typeof databaseOrSkip>,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await database.query<{ readonly blocked: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE '%WITH fenced_question%'
      ) AS blocked
    `);
    if (result.rows[0]?.blocked === true) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("answer reservation did not reach its controlled job fence");
}

usePostgresIntegrationDatabase();

describe("PostgreSQL answer cancellation and retraction", () => {
  it("rejects a reservation already waiting when cancellation terminalizes the job", async (context) => {
    const database = databaseOrSkip(context);
    const questionId = "77777777777777776";
    const effectId = `meeting-knowledge-answer:v1:${questionId}`;
    await database.query(
      `INSERT INTO meeting_knowledge.question_jobs (
         question_id, requester_subject, question_hash, scope_id,
         final_projection_receipt, authorization_principal_ref,
         authorization_digest, locale, question_text, binding, binding_hash,
         state, generation, lease_owner, lease_until, expires_at
       ) VALUES (
         $1, $2, $3, 'scope-1', 'projection-1', 'opaque-principal',
         $4, 'en', 'Sensitive question?', $5::jsonb, $6,
         'running', 1, 'worker-1',
         transaction_timestamp() + interval '1 minute',
         transaction_timestamp() + interval '10 minutes'
       )`,
      [
        questionId,
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        { meetingId: "source-meeting-1" },
        "d".repeat(64),
      ],
    );
    const cancellation = await database.connect();
    try {
      await cancellation.query("BEGIN");
      await cancellation.query(
        `SELECT question_id FROM meeting_knowledge.question_jobs
         WHERE question_id = $1 FOR UPDATE`,
        [questionId],
      );
      const reservation = new PostgresAnswerEffectStore(database).reserve({
        authorizationDigest: "c".repeat(64),
        bindingHash: "d".repeat(64),
        deliveryContainerId: channelId,
        effectId,
        marker: effectId,
        payloadBytes: "{}",
        payloadHash: digest("{}"),
        projectionTargetContainerId: channelId,
        questionFence: { generation: 1, jobId: questionId },
        replyToRemoteMessageId: questionId,
        sourceMeetingIds: ["source-meeting-1"],
      });
      await waitForBlockedAnswerFence(database);
      await cancellation.query(
        `UPDATE meeting_knowledge.question_jobs
         SET state = 'terminal', outcome = 'cancelled',
             authorization_principal_ref = NULL, question_text = NULL,
             binding = NULL, grounding_plan = NULL, answer_candidate = NULL,
             lease_owner = NULL, lease_until = NULL,
             terminal_at = transaction_timestamp(),
             scrubbed_at = transaction_timestamp()
         WHERE question_id = $1`,
        [questionId],
      );
      await cancellation.query("COMMIT");

      await expect(reservation).resolves.toEqual({ status: "stale_fence" });
      await expect(database.query(
        "SELECT 1 FROM meeting_core.answer_effects WHERE effect_id = $1",
        [effectId],
      )).resolves.toMatchObject({ rowCount: 0 });
    } finally {
      await cancellation.query("ROLLBACK").catch(() => {});
      cancellation.release();
    }
  });

  it("tombstones a source without a historical row and rejects every later release", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresHistoricalMemoryStore(database);
    const meetingId = "meeting-withdrawn-before-release";

    await store.requestMeetingDeletion(meetingId);
    await store.requestMeetingDeletion(meetingId);

    await expect(database.query(
      `SELECT meeting_id FROM meeting_knowledge.withdrawn_meeting_sources
       WHERE meeting_id = $1`,
      [meetingId],
    )).resolves.toMatchObject({ rows: [{ meeting_id: meetingId }] });
    await expect(store.acceptRelease(createHistoricalReleaseBinding({
      acceptedMeetingRevision: 1,
      desiredGeneration: 1,
      meetingId,
      roomId: "room-1",
      scopeId: "scope-1",
      transcriptId: "late-transcript",
      transcriptVersion: 1,
    }))).rejects.toThrow("withdrawn meeting");
    await expect(store.claimNext({
      allowIndex: false,
      leaseDurationMs: 30_000,
    })).resolves.toBeNull();
  });

  it("retains authoritative evidence while withdrawal requests exact answer retraction", async (context) => {
    const database = databaseOrSkip(context);
    const sourceMeetingId = "withdrawn-answer-source";
    const meeting = evidenceBackedMeeting(sourceMeetingId, channelId).toSnapshot();
    await database.query(
      `INSERT INTO meeting_core.meetings (meeting_id, revision, snapshot)
       VALUES ($1, $2, $3::jsonb)`,
      [meeting.meetingId, meeting.revision, meeting],
    );
    for (const [suffix, state, receipt, payload] of [
      ["delivered", "delivered", "88888888888888888", "{}"],
      ["unknown", "outcome_unknown", null, '{"content":"answer"}'],
    ] as const) {
      await database.query(
        `INSERT INTO meeting_core.answer_effects (
           effect_id, state, projection_target_container_id,
           delivery_container_id, reply_to_remote_message_id, marker,
           payload_bytes, payload_hash, binding_hash, authorization_digest,
           source_meeting_ids, request_started_at, external_receipt, settled_at
         ) VALUES (
           $1, $2, $3, $3, $4, $5, $6, $7, $8, $9,
           ARRAY[$10]::text[], transaction_timestamp(), $11,
           CASE WHEN $2 = 'delivered' THEN transaction_timestamp() ELSE NULL END
         )`,
        [
          `meeting-knowledge-answer:v1:withdraw-${suffix}`,
          state,
          channelId,
          `7777777777777777${suffix === "delivered" ? "1" : "2"}`,
          `marker-${suffix}`,
          payload,
          digest(payload),
          "b".repeat(64),
          "c".repeat(64),
          sourceMeetingId,
          receipt,
        ],
      );
    }

    await new PostgresHistoricalMemoryStore(database)
      .requestMeetingDeletion(sourceMeetingId);

    const effects = await database.query(
      `SELECT state, external_receipt, marker, payload_bytes, payload_hash
       FROM meeting_core.answer_effects
       ORDER BY effect_id`,
    );
    expect(effects.rows).toEqual([
      {
        external_receipt: "88888888888888888",
        marker: "marker-delivered",
        payload_bytes: "{}",
        payload_hash: digest("{}"),
        state: "retraction_pending",
      },
      {
        external_receipt: null,
        marker: "marker-unknown",
        payload_bytes: "{}",
        payload_hash: digest('{"content":"answer"}'),
        state: "retraction_pending",
      },
    ]);
    await expect(database.query(
      "SELECT snapshot FROM meeting_core.meetings WHERE meeting_id = $1",
      [sourceMeetingId],
    )).resolves.toMatchObject({ rowCount: 1 });
  });
});

describe("PostgreSQL withdrawal fencing", () => {

  it("cancels a pre-grounding no-Infinity job from its admitted source binding", async (context) => {
    const database = databaseOrSkip(context);
    const meetingId = "pre-grounding-withdrawn-source";
    const questionId = "pre-grounding-question";
    await insertRunningQuestion(database, {
      meetingId,
      projectionReceipt: "projection-pre-grounding",
      questionId,
    });

    await new PostgresHistoricalMemoryStore(database).requestMeetingDeletion(meetingId);

    await expect(database.query(
      `SELECT state, outcome, binding, source_meeting_ids
       FROM meeting_knowledge.question_jobs
       WHERE question_id = $1`,
      [questionId],
    )).resolves.toMatchObject({
      rows: [{
        binding: null,
        outcome: "cancelled",
        source_meeting_ids: [],
        state: "terminal",
      }],
    });
    await expect(new PostgresQuestionJobStore(database).persistGroundingPlan({
      generation: 1,
      jobId: questionId,
      measurement: { inputTokens: 10, requestBytes: 100 },
      plan: groundingPlan(meetingId),
      runtimeProfile: "test-runtime",
      sourceMeetingIds: [meetingId],
    })).resolves.toBe(false);
  });

  it("serializes a new grounding source with its tombstone", async (context) => {
    const database = databaseOrSkip(context);
    const admittedMeetingId = "admitted-source";
    const historicalMeetingId = "racing-historical-source";
    const questionId = "racing-grounding-question";
    await insertRunningQuestion(database, {
      meetingId: admittedMeetingId,
      projectionReceipt: "projection-racing-grounding",
      questionId,
      sourceMeetingIds: [admittedMeetingId],
    });
    const jobs = new PostgresQuestionJobStore(database);
    const deletion = new PostgresHistoricalMemoryStore(database);

    const [persisted] = await Promise.all([
      jobs.persistGroundingPlan({
        generation: 1,
        jobId: questionId,
        measurement: { inputTokens: 10, requestBytes: 100 },
        plan: groundingPlan(historicalMeetingId),
        runtimeProfile: "test-runtime",
        sourceMeetingIds: [admittedMeetingId, historicalMeetingId],
      }),
      deletion.requestMeetingDeletion(historicalMeetingId),
    ]);
    const stored = await database.query<{
      readonly grounding_plan: unknown;
      readonly state: string;
    }>(
      `SELECT grounding_plan, state
       FROM meeting_knowledge.question_jobs
       WHERE question_id = $1`,
      [questionId],
    );
    if (persisted) {
      expect(stored.rows).toEqual([{ grounding_plan: null, state: "terminal" }]);
    } else {
      expect(stored.rows).toEqual([{ grounding_plan: null, state: "running" }]);
    }
    await expect(jobs.persistGroundingPlan({
      generation: 1,
      jobId: questionId,
      measurement: { inputTokens: 10, requestBytes: 100 },
      plan: groundingPlan(historicalMeetingId),
      runtimeProfile: "test-runtime",
      sourceMeetingIds: [admittedMeetingId, historicalMeetingId],
    })).resolves.toBe(false);
    await expect(jobs.markReady({
      answerCandidate: {
        claims: [{ evidenceIds: ["evidence-000001"], text: "Unsafe answer" }],
        locale: "en",
        status: "answered",
      },
      generation: 1,
      jobId: questionId,
    })).resolves.toBe(false);
  });

  it("orders overlapping source and projection withdrawal row locks", async (context) => {
    const database = databaseOrSkip(context);
    const meetingId = "overlapping-withdrawal-source";
    const projectionReceipt = "overlapping-withdrawal-projection";
    const questionIds = ["withdrawal-z-question", "withdrawal-a-question"];
    for (const questionId of questionIds) {
      await insertRunningQuestion(database, {
        meetingId,
        projectionReceipt,
        questionId,
        sourceMeetingIds: [meetingId],
      });
      await database.query(
        `INSERT INTO meeting_core.answer_effects (
           effect_id, projection_target_container_id, delivery_container_id,
           reply_to_remote_message_id, marker, payload_bytes, payload_hash,
           binding_hash, authorization_digest, source_meeting_ids
         ) VALUES ($1, $2, $2, $3, $1, '{}', $4, $5, $6, ARRAY[$7]::text[])`,
        [
          `meeting-knowledge-answer:v1:${questionId}`,
          channelId,
          questionId,
          digest("{}"),
          "b".repeat(64),
          "c".repeat(64),
          meetingId,
        ],
      );
    }

    const [, affectedQuestions] = await Promise.all([
      new PostgresHistoricalMemoryStore(database).requestMeetingDeletion(meetingId),
      new PostgresQuestionAdmissionCommit(database, "bot-test")
        .withdrawProjection({ finalProjectionReceipt: projectionReceipt }),
    ]);

    expect(affectedQuestions).toEqual(questionIds.toSorted());
    await expect(database.query(
      `SELECT state FROM meeting_knowledge.question_jobs ORDER BY question_id`,
    )).resolves.toMatchObject({
      rows: [{ state: "terminal" }, { state: "terminal" }],
    });
    await expect(database.query(
      `SELECT state FROM meeting_core.answer_effects ORDER BY effect_id`,
    )).resolves.toMatchObject({
      rows: [{ state: "cancelled" }, { state: "cancelled" }],
    });
  });
});
