import { QuestionBinding } from "@discord-meeting/meeting-core/meeting-knowledge";
import { describe, expect, it } from "vitest";

import {
  PostgresAnswerEffectStore,
  PostgresFinalReplyMaintenance,
  PostgresQuestionJobStore,
  type QuestionPolicyIdentity,
} from "../src/index.js";
import {
  databaseOrSkip,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

usePostgresIntegrationDatabase();

const oldPolicy = Object.freeze({
  authorizationPolicyVersion: "discord.participant-current-results.v1",
  policyEpoch: 1,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
});
const nextPolicy = Object.freeze({
  authorizationPolicyVersion: "discord.participant-current-results.v2",
  policyEpoch: 2,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v3",
});

function policyBinding(id: string, policy: QuestionPolicyIdentity) {
  return QuestionBinding.create({
    authorizationDigest: "a".repeat(64),
    authorizationPolicyVersion: policy.authorizationPolicyVersion,
    authorizationPrincipalRef: `principal-${id}`,
    botApplicationIdentity: "11111111111111111",
    canonicalEvidenceHash: "b".repeat(64),
    deliveryContainerId: "22222222222222222",
    expectedLocale: "en",
    finalProjectionEpoch: "projection-epoch",
    finalProjectionReceipt: `receipt-${id}`,
    humanActorIds: ["speaker-a"],
    meetingId: `meeting-${id}`,
    meetingRevision: 1,
    memoryGeneration: `focused-memory:v1:${"b".repeat(64)}`,
    policyVersion: policy.policyVersion,
    projectionTargetContainerId: "22222222222222222",
    questionHash: "c".repeat(64),
    questionId: id,
    requesterSubject: "d".repeat(64),
    roomId: "room-policy",
    scopeId: "scope-policy",
    transcriptId: "transcript-policy",
    transcriptVersion: 1,
  }).toSnapshot();
}

async function insertQueuedPolicyJob(
  database: ReturnType<typeof databaseOrSkip>,
  binding: ReturnType<typeof policyBinding>,
  policyEpoch: number,
): Promise<void> {
  await database.query(
    `INSERT INTO meeting_knowledge.question_jobs (
       question_id, requester_subject, question_hash, scope_id,
       final_projection_receipt, authorization_principal_ref,
       authorization_digest, locale, question_text, binding, binding_hash,
       policy_epoch, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'en', 'Question?', $8::jsonb,
       $9, $10, transaction_timestamp() + interval '10 minutes'
     )`,
    [
      binding.questionId,
      binding.requesterSubject,
      binding.questionHash,
      binding.scopeId,
      binding.finalProjectionReceipt,
      binding.authorizationPrincipalRef,
      binding.authorizationDigest,
      binding,
      "f".repeat(64),
      policyEpoch,
    ],
  );
}

async function waitForPolicyFenceWait(
  database: ReturnType<typeof databaseOrSkip>,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await database.query<{ readonly blocked: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE '%INSERT INTO meeting_knowledge.current_question_policy%'
      ) AS blocked
    `);
    if (result.rows[0]?.blocked === true) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("effect request did not reach the controlled policy fence");
}

describe("PostgreSQL question policy fence", () => {
  it("activates the next epoch from maintenance while serving is disabled", async (context) => {
    const database = databaseOrSkip(context);
    const oldStore = new PostgresQuestionJobStore(database, oldPolicy);
    const initialBinding = policyBinding("policy-maintenance-initial", oldPolicy);
    await insertQueuedPolicyJob(database, initialBinding, oldPolicy.policyEpoch);
    await expect(oldStore.leaseNext({ leaseSeconds: 60, workerId: "old-worker" }))
      .resolves.toMatchObject({ jobId: initialBinding.questionId });

    const maintenance = new PostgresFinalReplyMaintenance(database, nextPolicy);
    await expect(maintenance.maintain({ maximumJobs: 100, servingEnabled: false }))
      .resolves.toMatchObject({ cancelled: 1 });

    const current = await database.query<{
      readonly authorization_policy_version: string;
      readonly policy_epoch: number;
      readonly policy_version: string;
    }>(
      `SELECT policy_epoch, policy_version, authorization_policy_version
       FROM meeting_knowledge.current_question_policy
       WHERE policy_key = 'local-final-reply'`,
    );
    expect(current.rows).toEqual([{
      authorization_policy_version: nextPolicy.authorizationPolicyVersion,
      policy_epoch: nextPolicy.policyEpoch,
      policy_version: nextPolicy.policyVersion,
    }]);

    const staleBinding = policyBinding("policy-maintenance-stale", oldPolicy);
    await insertQueuedPolicyJob(database, staleBinding, oldPolicy.policyEpoch);
    await expect(oldStore.leaseNext({ leaseSeconds: 60, workerId: "old-worker" }))
      .resolves.toBeNull();
  });

  it("prevents an old pod from leasing or processing after the epoch switch", async (context) => {
    const database = databaseOrSkip(context);
    const oldStore = new PostgresQuestionJobStore(database, oldPolicy);
    const oldBinding = policyBinding("policy-old-question", oldPolicy);
    await insertQueuedPolicyJob(database, oldBinding, oldPolicy.policyEpoch);
    const oldLease = await oldStore.leaseNext({ leaseSeconds: 60, workerId: "old-worker" });
    expect(oldLease?.jobId).toBe(oldBinding.questionId);

    const nextStore = new PostgresQuestionJobStore(database, nextPolicy);
    await expect(nextStore.leaseNext({ leaseSeconds: 60, workerId: "next-worker" }))
      .resolves.toBeNull();
    await expect(oldStore.confirmActiveLease({
      generation: oldLease?.generation ?? 0,
      jobId: oldBinding.questionId,
    })).resolves.toBe(false);

    const nextBinding = policyBinding("policy-next-question", nextPolicy);
    await insertQueuedPolicyJob(database, nextBinding, nextPolicy.policyEpoch);
    await expect(oldStore.leaseNext({ leaseSeconds: 60, workerId: "old-worker" }))
      .resolves.toBeNull();
    await expect(nextStore.leaseNext({ leaseSeconds: 60, workerId: "next-worker" }))
      .resolves.toMatchObject({ jobId: nextBinding.questionId });
  });

  it("linearizes request start behind a concurrent policy switch", async (context) => {
    const database = databaseOrSkip(context);
    const oldStore = new PostgresQuestionJobStore(database, oldPolicy);
    const binding = policyBinding("policy-request-question", oldPolicy);
    await insertQueuedPolicyJob(database, binding, oldPolicy.policyEpoch);
    const lease = await oldStore.leaseNext({ leaseSeconds: 60, workerId: "old-worker" });
    expect(lease).not.toBeNull();

    const effects = new PostgresAnswerEffectStore(database, oldPolicy);
    const effectId = `meeting-knowledge-answer:v1:${binding.questionId}`;
    await expect(effects.reserve({
      authorizationDigest: binding.authorizationDigest,
      bindingHash: "e".repeat(64),
      deliveryContainerId: binding.deliveryContainerId,
      effectId,
      marker: effectId,
      payloadBytes: "{}",
      payloadHash: "f".repeat(64),
      projectionTargetContainerId: binding.projectionTargetContainerId,
      questionFence: {
        generation: lease?.generation ?? 0,
        jobId: binding.questionId,
      },
      replyToRemoteMessageId: binding.questionId,
      sourceMeetingIds: [binding.meetingId],
    })).resolves.toEqual({ status: "reserved" });
    const claim = await effects.claim(effectId, "old-worker");
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") {
      throw new Error("answer effect claim unexpectedly failed");
    }

    const activation = await database.connect();
    try {
      await activation.query("BEGIN");
      await activation.query(
        `UPDATE meeting_knowledge.current_question_policy
         SET policy_epoch = $1, policy_version = $2,
             authorization_policy_version = $3,
             activated_at = transaction_timestamp()
         WHERE policy_key = 'local-final-reply'`,
        [
          nextPolicy.policyEpoch,
          nextPolicy.policyVersion,
          nextPolicy.authorizationPolicyVersion,
        ],
      );
      const requestStart = effects.startRequest({
        authorizationDigest: binding.authorizationDigest,
        effectId,
        generation: claim.generation,
        questionGeneration: lease?.generation ?? 0,
      });
      await waitForPolicyFenceWait(database);
      await activation.query("COMMIT");
      await expect(requestStart).resolves.toBe(false);
    } finally {
      await activation.query("ROLLBACK");
      activation.release();
    }

    await expect(effects.findById(effectId)).resolves.toMatchObject({ state: "cancelled" });
  });

  it("rejects request start after an exact lease-generation takeover", async (context) => {
    const database = databaseOrSkip(context);
    const jobs = new PostgresQuestionJobStore(database, oldPolicy);
    const binding = policyBinding("policy-lease-takeover-question", oldPolicy);
    await insertQueuedPolicyJob(database, binding, oldPolicy.policyEpoch);
    const staleLease = await jobs.leaseNext({ leaseSeconds: 60, workerId: "stale-worker" });
    expect(staleLease).not.toBeNull();

    const effects = new PostgresAnswerEffectStore(database, oldPolicy);
    const effectId = `meeting-knowledge-answer:v1:${binding.questionId}`;
    await expect(effects.reserve({
      authorizationDigest: binding.authorizationDigest,
      bindingHash: "e".repeat(64),
      deliveryContainerId: binding.deliveryContainerId,
      effectId,
      marker: effectId,
      payloadBytes: "{}",
      payloadHash: "f".repeat(64),
      projectionTargetContainerId: binding.projectionTargetContainerId,
      questionFence: {
        generation: staleLease?.generation ?? 0,
        jobId: binding.questionId,
      },
      replyToRemoteMessageId: binding.questionId,
      sourceMeetingIds: [binding.meetingId],
    })).resolves.toEqual({ status: "reserved" });
    const claim = await effects.claim(effectId, "stale-worker");
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") {
      throw new Error("answer effect claim unexpectedly failed");
    }

    await database.query(
      `UPDATE meeting_knowledge.question_jobs
       SET lease_until = transaction_timestamp() - interval '1 second'
       WHERE question_id = $1`,
      [binding.questionId],
    );
    const replacementLease = await jobs.leaseNext({
      leaseSeconds: 60,
      workerId: "replacement-worker",
    });
    expect(replacementLease?.generation).toBe((staleLease?.generation ?? 0) + 1);

    await expect(effects.startRequest({
      authorizationDigest: binding.authorizationDigest,
      effectId,
      generation: claim.generation,
      questionGeneration: staleLease?.generation ?? 0,
    })).resolves.toBe(false);
    await expect(effects.findById(effectId)).resolves.toMatchObject({ state: "cancelled" });
  });
});
