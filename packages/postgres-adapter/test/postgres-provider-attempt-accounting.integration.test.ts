import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { PostgresQuestionJobStore } from "../src/index.js";
import {
  databaseOrSkip,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

usePostgresIntegrationDatabase();
const questionPolicy = Object.freeze({
  authorizationPolicyVersion: "discord.participant-current-results.v1",
  policyEpoch: 1,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
});


describe("PostgreSQL provider attempt accounting", () => {
  it("never replays selection after a reserved-attempt crash window", async (context) => {
    const database = databaseOrSkip(context);
    const questionId = "77777777777777776";
    await database.query(
      `
        INSERT INTO meeting_knowledge.question_jobs (
          question_id, requester_subject, question_hash, scope_id,
          final_projection_receipt, authorization_principal_ref,
          authorization_digest, locale, question_text, binding, binding_hash,
          state, generation, lease_owner, lease_until,
          worker_protocol_epoch, worker_protocol_generation, expires_at
        ) VALUES (
          $1, $2, $3, 'scope-lost-provider', 'projection-lost-provider',
          'opaque', $4, 'en', 'Question?', jsonb_build_object(
            'policyVersion', 'meeting-knowledge.focused-memory-final-reply.v2',
            'authorizationPolicyVersion', 'discord.participant-current-results.v1'), $5,
          'running', 1, 'provider-worker',
          transaction_timestamp() + interval '1 minute',
          2, 1,
          transaction_timestamp() + interval '10 minutes'
        )
      `,
      [
        questionId,
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
      ],
    );
    const jobs = new PostgresQuestionJobStore(database, questionPolicy);
    expect(await jobs.reserveProviderAttempt({
      attemptId: "lost-provider-attempt-1",
      generation: 1,
      jobId: questionId,
      leaseSeconds: 240,
      maximumProviderAttempts: 2,
    })).toBe(true);
    await expect(jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "competing-during-provider-call",
    })).resolves.toBeNull();
    await database.query(
      `
        UPDATE meeting_knowledge.question_jobs
        SET lease_until = transaction_timestamp() - interval '1 second'
        WHERE question_id = $1
      `,
      [questionId],
    );
    await expect(jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "competing-after-provider-loss",
    })).resolves.toBeNull();
    const stored = await database.query(
      `
        SELECT attempts, outcome, provider_attempt_state, state
        FROM meeting_knowledge.question_jobs
        WHERE question_id = $1
      `,
      [questionId],
    );
    expect(stored.rows[0]).toEqual({
      attempts: 1,
      outcome: "unavailable",
      provider_attempt_state: "reserved",
      state: "terminal",
    });
  });

  it("rejects an attempt reservation after the durable maximum", async (context) => {
    const database = databaseOrSkip(context);
    await database.query(
      `
        INSERT INTO meeting_knowledge.question_jobs (
          question_id, requester_subject, question_hash, scope_id,
          final_projection_receipt, authorization_principal_ref,
          authorization_digest, locale, question_text, binding, binding_hash,
          state, attempts, generation, lease_owner, lease_until,
          worker_protocol_epoch, worker_protocol_generation, expires_at
        ) VALUES (
          '77777777777777775', $1, $2, 'scope-max', 'projection-max', 'opaque',
          $3, 'en', 'Question?', jsonb_build_object(
            'policyVersion', 'meeting-knowledge.focused-memory-final-reply.v2',
            'authorizationPolicyVersion', 'discord.participant-current-results.v1'), $4, 'running', 2, 1, 'worker',
          transaction_timestamp() + interval '1 minute',
          2, 1,
          transaction_timestamp() + interval '10 minutes'
        )
      `,
      ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64)],
    );
    const jobs = new PostgresQuestionJobStore(database, questionPolicy);
    await expect(jobs.reserveProviderAttempt({
      attemptId: "forbidden-attempt-3",
      generation: 1,
      jobId: "77777777777777775",
      leaseSeconds: 240,
      maximumProviderAttempts: 2,
    })).resolves.toBe(false);
  });

});

describe("PostgreSQL provider attempt recovery", () => {

  it("rejects pre-v2 lease claims after protocol activation", async (context) => {
    const database = databaseOrSkip(context);
    const questionId = "77777777777777774";
    await insertQueued(database, questionId, 600);
    await expect(database.query(
      `
        UPDATE meeting_knowledge.question_jobs
        SET state = 'running',
            generation = generation + 1,
            lease_owner = 'old-worker',
            lease_until = transaction_timestamp() + interval '1 minute'
        WHERE question_id = $1
      `,
      [questionId],
    )).rejects.toThrow(/question_jobs_running_worker_protocol_is_current/u);

    const jobs = new PostgresQuestionJobStore(database, questionPolicy);
    await expect(jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "epoch-2-worker",
    })).resolves.toMatchObject({ generation: 1, jobId: questionId });
  });

  it("refuses a provider reservation without the full deadline budget", async (context) => {
    const database = databaseOrSkip(context);
    const questionId = "77777777777777773";
    await insertQueued(database, questionId, 120);
    const jobs = new PostgresQuestionJobStore(database, questionPolicy);
    const lease = await jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "ttl-worker",
    });
    expect(lease).not.toBeNull();
    await expect(jobs.reserveProviderAttempt({
      attemptId: "ttl-attempt-1",
      generation: lease?.generation ?? 0,
      jobId: questionId,
      leaseSeconds: 240,
      maximumProviderAttempts: 2,
    })).resolves.toBe(false);
    const stored = await database.query(
      `SELECT attempts, provider_attempt_state FROM meeting_knowledge.question_jobs
       WHERE question_id = $1`,
      [questionId],
    );
    expect(stored.rows[0]).toEqual({ attempts: 0, provider_attempt_state: "none" });
  });

  it("atomically makes a completed attempt ready for publication", async (context) => {
    const database = databaseOrSkip(context);
    const questionId = "77777777777777772";
    await insertQueued(database, questionId, 600);
    const jobs = new PostgresQuestionJobStore(database, questionPolicy);
    const lease = await jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "completion-worker",
    });
    expect(lease).not.toBeNull();
    await database.query(
      `UPDATE meeting_knowledge.question_jobs SET grounding_plan = $2::jsonb
       WHERE question_id = $1`,
      [questionId, JSON.stringify(groundingPlan())],
    );
    expect(await jobs.reserveProviderAttempt({
      attemptId: "completed-attempt-1",
      generation: lease?.generation ?? 0,
      jobId: questionId,
      leaseSeconds: 240,
      maximumProviderAttempts: 2,
    })).toBe(true);
    expect(await jobs.completeProviderAttempt({
      answerCandidate: answerCandidate(),
      attemptId: "completed-attempt-1",
      generation: lease?.generation ?? 0,
      jobId: questionId,
    })).toBe(true);
    const stored = await database.query(
      `SELECT provider_attempt_state, state FROM meeting_knowledge.question_jobs
       WHERE question_id = $1`,
      [questionId],
    );
    expect(stored.rows[0]).toEqual({ provider_attempt_state: "completed", state: "ready" });
    await database.query(
      `UPDATE meeting_knowledge.question_jobs
       SET lease_until = transaction_timestamp() - interval '1 second'
       WHERE question_id = $1`,
      [questionId],
    );
    await expect(jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "publication-worker",
    })).resolves.toMatchObject({ state: "ready" });
  });

  it("terminalizes a legacy completed-without-ready crash boundary", async (context) => {
    const database = databaseOrSkip(context);
    const questionId = "77777777777777771";
    await insertQueued(database, questionId, 600);
    const jobs = new PostgresQuestionJobStore(database, questionPolicy);
    const lease = await jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "legacy-completion-worker",
    });
    expect(await jobs.reserveProviderAttempt({
      attemptId: "legacy-completed-attempt",
      generation: lease?.generation ?? 0,
      jobId: questionId,
      leaseSeconds: 240,
      maximumProviderAttempts: 2,
    })).toBe(true);
    await database.query(
      `UPDATE meeting_knowledge.question_jobs
       SET provider_attempt_state = 'completed',
           provider_attempt_finished_at = transaction_timestamp(),
           lease_until = transaction_timestamp() - interval '1 second'
       WHERE question_id = $1`,
      [questionId],
    );
    await expect(jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "recovery-worker",
    })).resolves.toBeNull();
    const stored = await database.query(
      `SELECT outcome, state FROM meeting_knowledge.question_jobs WHERE question_id = $1`,
      [questionId],
    );
    expect(stored.rows[0]).toEqual({ outcome: "unavailable", state: "terminal" });
  });

  it("atomically terminalizes a non-retryable provider failure", async (context) => {
    const database = databaseOrSkip(context);
    const questionId = "77777777777777770";
    await insertQueued(database, questionId, 600);
    const jobs = new PostgresQuestionJobStore(database, questionPolicy);
    const lease = await jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "failure-worker",
    });
    expect(await jobs.reserveProviderAttempt({
      attemptId: "invalid-attestation-attempt",
      generation: lease?.generation ?? 0,
      jobId: questionId,
      leaseSeconds: 240,
      maximumProviderAttempts: 2,
    })).toBe(true);
    await expect(jobs.failProviderAttempt({
      attemptId: "invalid-attestation-attempt",
      generation: lease?.generation ?? 0,
      jobId: questionId,
      maximumProviderAttempts: 2,
      reason: "invalid_attestation",
      retryable: false,
    })).resolves.toBe("settled");
    const stored = await database.query(
      `SELECT outcome, provider_attempt_retryable, question_text, state
       FROM meeting_knowledge.question_jobs WHERE question_id = $1`,
      [questionId],
    );
    expect(stored.rows[0]).toEqual({
      outcome: "unavailable",
      provider_attempt_retryable: false,
      question_text: null,
      state: "terminal",
    });
  });
});

async function insertQueued(
  database: Pool,
  questionId: string,
  expiresInSeconds: number,
): Promise<void> {
  const requesterSubject = "a".repeat(64);
  const questionHash = "b".repeat(64);
  const authorizationDigest = "c".repeat(64);
  const bindingHash = "d".repeat(64);
  const canonicalEvidenceHash = "e".repeat(64);
  const binding = {
    authorizationDigest,
    authorizationPolicyVersion: "discord.participant-current-results.v1",
    authorizationPrincipalRef: "opaque-principal",
    botApplicationIdentity: "bot-application",
    canonicalEvidenceHash,
    deliveryContainerId: "delivery-channel",
    expectedLocale: "en",
    finalProjectionEpoch: "projection-epoch",
    finalProjectionReceipt: `projection-${questionId}`,
    humanActorIds: ["human-actor"],
    meetingId: "meeting-provider-accounting",
    meetingRevision: 1,
    memoryGeneration: `focused-memory:v1:${canonicalEvidenceHash}`,
    policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
    projectionTargetContainerId: "projection-channel",
    questionHash,
    questionId,
    requesterSubject,
    roomId: "room-provider-accounting",
    scopeId: "scope-provider-accounting",
    transcriptId: "transcript-provider-accounting",
    transcriptVersion: 1,
  };
  await database.query(
    `
      INSERT INTO meeting_knowledge.question_jobs (
        question_id, requester_subject, question_hash, scope_id,
        final_projection_receipt, authorization_principal_ref,
        authorization_digest, locale, question_text, binding, binding_hash, expires_at
      ) VALUES (
        $1, $2, $3, 'scope-provider-accounting', $4, 'opaque-principal',
        $5, 'en', 'Question?', $6::jsonb, $7,
        transaction_timestamp() + make_interval(secs => $8)
      )
    `,
    [
      questionId,
      requesterSubject,
      questionHash,
      binding.finalProjectionReceipt,
      authorizationDigest,
      JSON.stringify(binding),
      bindingHash,
      expiresInSeconds,
    ],
  );
}

function groundingPlan() {
  return {
    authorityGeneration: `focused-memory:v1:${"e".repeat(64)}`,
    evidence: [{
      endMs: 1,
      evidenceId: "evidence-000001",
      speakerId: "human-actor",
      startMs: 0,
      text: "Friday.",
      turnHash: "f".repeat(64),
      turnId: "turn-provider-accounting",
    }],
    mode: "focused_retrieval",
  };
}

function answerCandidate() {
  return {
    claims: [{ evidenceIds: ["evidence-000001"], text: "Friday." }],
    locale: "en" as const,
    status: "answered" as const,
  };
}
