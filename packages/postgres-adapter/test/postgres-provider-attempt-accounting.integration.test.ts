import { describe, expect, it } from "vitest";

import { PostgresQuestionJobStore } from "../src/index.js";
import {
  databaseOrSkip,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

usePostgresIntegrationDatabase();

describe("PostgreSQL provider attempt accounting", () => {
  it("never reclaims an expired reserved provider attempt", async (context) => {
    const database = databaseOrSkip(context);
    const questionId = "77777777777777776";
    await database.query(
      `
        INSERT INTO meeting_knowledge.question_jobs (
          question_id, requester_subject, question_hash, scope_id,
          final_projection_receipt, authorization_principal_ref,
          authorization_digest, locale, question_text, binding, binding_hash,
          state, generation, lease_owner, lease_until, expires_at
        ) VALUES (
          $1, $2, $3, 'scope-lost-provider', 'projection-lost-provider',
          'opaque', $4, 'en', 'Question?', '{}'::jsonb, $5,
          'running', 1, 'provider-worker',
          transaction_timestamp() + interval '1 minute',
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
    const jobs = new PostgresQuestionJobStore(database);
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
          state, attempts, generation, lease_owner, lease_until, expires_at
        ) VALUES (
          '77777777777777775', $1, $2, 'scope-max', 'projection-max', 'opaque',
          $3, 'en', 'Question?', '{}'::jsonb, $4, 'running', 2, 1, 'worker',
          transaction_timestamp() + interval '1 minute',
          transaction_timestamp() + interval '10 minutes'
        )
      `,
      ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64)],
    );
    const jobs = new PostgresQuestionJobStore(database);
    await expect(jobs.reserveProviderAttempt({
      attemptId: "forbidden-attempt-3",
      generation: 1,
      jobId: "77777777777777775",
      leaseSeconds: 240,
      maximumProviderAttempts: 2,
    })).resolves.toBe(false);
  });
});
