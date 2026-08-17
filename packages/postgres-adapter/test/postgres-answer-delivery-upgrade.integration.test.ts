import { createHash } from "node:crypto";

import {
  QuestionBinding,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  DurableAnswerPublication,
  type AnswerDeliveryPort,
  type AnswerPayloadPort,
} from "@discord-meeting/meeting-core/publishing";
import { describe, expect, it } from "vitest";

import {
  PostgresAnswerEffectStore,
  PostgresMigrationRunner,
  PostgresQuestionAdmissionCommit,
  PostgresQuestionJobStore,
  PostgresSchemaReadiness,
  loadPostgresMigrations,
} from "../src/index.js";
import {
  createIsolatedDatabase,
  databaseOrSkip,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

usePostgresIntegrationDatabase();

const parentContainerId = "111111111111111111";
const threadContainerId = "222222222222222222";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function legacyBinding(questionId: string, receipt: string) {
  return {
    authorizationDigest: "a".repeat(64),
    authorizationPolicyVersion: "discord.participant-current-results.v2",
    authorizationPrincipalRef: `opaque-${questionId}`,
    botApplicationIdentity: "333333333333333333",
    canonicalEvidenceHash: "b".repeat(64),
    expectedLocale: "en" as const,
    finalProjectionEpoch: "epoch-1",
    finalProjectionReceipt: receipt,
    humanActorIds: ["444444444444444444"],
    meetingId: "meeting-upgrade",
    meetingRevision: 1,
    memoryGeneration: `focused-memory:v1:${"b".repeat(64)}`,
    policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
    projectionTargetContainerId: parentContainerId,
    questionHash: "c".repeat(64),
    questionId,
    requesterSubject: "d".repeat(64),
    roomId: parentContainerId,
    scopeId: "555555555555555555",
    transcriptId: "transcript-upgrade",
    transcriptVersion: 1,
  };
}

function admissionHash(binding: ReturnType<typeof legacyBinding>): string {
  const { authorizationPrincipalRef: _principal, ...durable } = binding;
  return sha256(JSON.stringify(durable));
}

function answerPayload(containerId: string, questionId: string): string {
  return canonical({
    allowed_mentions: { parse: [], replied_user: false },
    embeds: [{
      description: "Recovered answer",
      url: `https://discord-meeting.invalid/knowledge-answer/${sha256(`marker-${questionId}`)}`,
    }],
    message_reference: {
      channel_id: containerId,
      fail_if_not_exists: true,
      message_id: questionId,
    },
  });
}

async function insertLegacyJob(
  database: import("pg").Pool,
  input: {
    readonly binding: ReturnType<typeof legacyBinding>;
    readonly leaseExpired?: boolean;
    readonly state: "queued" | "ready" | "running";
  },
): Promise<void> {
  await database.query(
    `
      INSERT INTO meeting_knowledge.question_jobs (
        question_id, requester_subject, question_hash, scope_id,
        final_projection_receipt, authorization_principal_ref,
        authorization_digest, locale, question_text, binding, binding_hash,
        state, attempts, generation, lease_owner, lease_until,
        grounding_plan, answer_candidate, ready_at, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, 'en', 'What happened?', $8::jsonb, $9,
        $10, 1, 1, $11,
        CASE WHEN $11::text IS NULL THEN NULL ELSE transaction_timestamp() - interval '1 minute' END,
        CASE WHEN $10 = 'ready' THEN $12::jsonb ELSE NULL END,
        CASE WHEN $10 = 'ready' THEN $13::jsonb ELSE NULL END,
        CASE WHEN $10 = 'ready' THEN transaction_timestamp() ELSE NULL END,
        transaction_timestamp() + interval '30 minutes'
      )
    `,
    [
      input.binding.questionId,
      input.binding.requesterSubject,
      input.binding.questionHash,
      input.binding.scopeId,
      input.binding.finalProjectionReceipt,
      input.binding.authorizationPrincipalRef,
      input.binding.authorizationDigest,
      JSON.stringify(input.binding),
      admissionHash(input.binding),
      input.state,
      input.state === "queued" ? null : "legacy-worker",
      JSON.stringify({
        authorityGeneration: input.binding.memoryGeneration,
        evidence: [{
          endMs: 1_000,
          evidenceId: "evidence-1",
          speakerId: input.binding.humanActorIds[0],
          startMs: 0,
          text: "Recovered evidence",
          turnHash: "e".repeat(64),
          turnId: "turn-1",
        }],
        mode: "focused_retrieval",
      }),
      JSON.stringify({
        claims: [{ evidenceIds: ["evidence-1"], text: "Recovered answer" }],
        locale: "en",
        status: "answered",
      }),
    ],
  );
}

describe("schema 17 answer-delivery upgrade", () => {
  it("recovers authoritative locations, preserves legacy idempotency, and fails closed", async (context) => {
    databaseOrSkip(context);
    const isolated = await createIsolatedDatabase();
    try {
      const migrations = await loadPostgresMigrations();
      await new PostgresMigrationRunner(isolated.pool, {
        migrations: migrations.slice(0, 17),
      }).migrate();

      const channelReceipt =
        `discord:v2:channel:${parentContainerId}:message:666666666666666666`;
      const threadReceipt =
        `discord:v2:thread:${threadContainerId}:message:777777777777777777`;
      const queued = legacyBinding("800000000000000001", channelReceipt);
      const running = legacyBinding("800000000000000002", threadReceipt);
      const ready = legacyBinding("800000000000000003", threadReceipt);
      const unknown = legacyBinding("800000000000000004", threadReceipt);
      const unrecoverable = legacyBinding("800000000000000005", "opaque-receipt");
      await insertLegacyJob(isolated.pool, { binding: queued, state: "queued" });
      await insertLegacyJob(isolated.pool, { binding: running, state: "running" });
      await insertLegacyJob(isolated.pool, { binding: ready, state: "ready" });
      await insertLegacyJob(isolated.pool, { binding: unknown, state: "ready" });
      await insertLegacyJob(isolated.pool, { binding: unrecoverable, state: "queued" });

      const legacyReadyPayload = answerPayload(parentContainerId, ready.questionId);
      const legacyUnknownPayload = answerPayload(parentContainerId, unknown.questionId);
      for (const [binding, state, payload] of [
        [ready, "reserved", legacyReadyPayload],
        [unknown, "outcome_unknown", legacyUnknownPayload],
        [unrecoverable, "reserved", answerPayload(parentContainerId, unrecoverable.questionId)],
      ] as const) {
        await isolated.pool.query(
          `
            INSERT INTO meeting_core.answer_effects (
              effect_id, state, projection_target_container_id,
              reply_to_remote_message_id, marker, payload_bytes, payload_hash,
              binding_hash, authorization_digest, request_started_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              CASE WHEN $2 = 'outcome_unknown' THEN transaction_timestamp() ELSE NULL END
            )
          `,
          [
            `meeting-knowledge-answer:v1:${binding.questionId}`,
            state,
            parentContainerId,
            binding.questionId,
            `marker-${binding.questionId}`,
            payload,
            sha256(payload),
            sha256(canonical(binding)),
            binding.authorizationDigest,
          ],
        );
      }

      await expect(new PostgresMigrationRunner(isolated.pool).migrate()).resolves.toEqual({
        appliedVersions: [18, 19, 20, 21],
        version: 21,
      });
      await expect(new PostgresMigrationRunner(isolated.pool).migrate()).resolves.toEqual({
        appliedVersions: [],
        version: 21,
      });
      await expect(new PostgresSchemaReadiness(isolated.pool).assertReady()).resolves.toBeUndefined();

      const terminal = await isolated.pool.query<{
        readonly binding: unknown;
        readonly outcome: string;
        readonly state: string;
      }>("SELECT state, outcome, binding FROM meeting_knowledge.question_jobs WHERE question_id = $1", [
        unrecoverable.questionId,
      ]);
      expect(terminal.rows[0]).toEqual({ binding: null, outcome: "stale_binding", state: "terminal" });
      const reconciledJob = await isolated.pool.query<{
        readonly binding: unknown;
        readonly outcome: string;
        readonly state: string;
      }>("SELECT state, outcome, binding FROM meeting_knowledge.question_jobs WHERE question_id = $1", [
        unknown.questionId,
      ]);
      expect(reconciledJob.rows[0]).toEqual({
        binding: null,
        outcome: "delivery_unknown",
        state: "terminal",
      });
      const terminalEffect = await isolated.pool.query<{
        readonly delivery_container_id: string | null;
        readonly payload_bytes: string;
        readonly state: string;
      }>(
        "SELECT state, delivery_container_id, payload_bytes FROM meeting_core.answer_effects WHERE effect_id = $1",
        [`meeting-knowledge-answer:v1:${unrecoverable.questionId}`],
      );
      expect(terminalEffect.rows[0]).toEqual({
        delivery_container_id: null,
        payload_bytes: "{}",
        state: "cancelled",
      });

      const jobs = new PostgresQuestionJobStore(isolated.pool);
      const firstLease = await jobs.leaseNext({ leaseSeconds: 60, workerId: "upgrade-worker" });
      const secondLease = await jobs.leaseNext({ leaseSeconds: 60, workerId: "upgrade-worker" });
      const thirdLease = await jobs.leaseNext({ leaseSeconds: 60, workerId: "upgrade-worker" });
      expect([firstLease?.binding.deliveryContainerId, secondLease?.binding.deliveryContainerId])
        .toEqual([parentContainerId, threadContainerId]);
      expect(thirdLease).toMatchObject({
        binding: { deliveryContainerId: threadContainerId },
        jobId: ready.questionId,
        state: "ready",
      });

      const upgradedQueued = QuestionBinding.create({
        ...queued,
        deliveryContainerId: parentContainerId,
      }).toSnapshot();
      const admission = new PostgresQuestionAdmissionCommit(
        isolated.pool,
        upgradedQueued.botApplicationIdentity,
      );
      await expect(admission.commit({
        authorization: {
          actorId: upgradedQueued.humanActorIds[0]!,
          containerId: parentContainerId,
          deliveryContainerId: parentContainerId,
          digest: upgradedQueued.authorizationDigest,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          observedAt: new Date().toISOString(),
          policyVersion: upgradedQueued.authorizationPolicyVersion,
          scopeId: upgradedQueued.scopeId,
          source: "authoritative_remote",
          status: "authorized",
        },
        binding: upgradedQueued,
        questionText: "What happened?",
        ratePolicy: {
          guildQuestionsPerHour: 100,
          jobTtlSeconds: 600,
          requesterQuestionsPerHour: 10,
        },
      })).resolves.toEqual({ jobId: queued.questionId, status: "duplicate" });
      await expect(admission.commit({
        authorization: {
          actorId: upgradedQueued.humanActorIds[0]!,
          containerId: parentContainerId,
          deliveryContainerId: threadContainerId,
          digest: upgradedQueued.authorizationDigest,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          observedAt: new Date().toISOString(),
          policyVersion: upgradedQueued.authorizationPolicyVersion,
          scopeId: upgradedQueued.scopeId,
          source: "authoritative_remote",
          status: "authorized",
        },
        binding: { ...upgradedQueued, deliveryContainerId: threadContainerId },
        questionText: "What happened?",
        ratePolicy: {
          guildQuestionsPerHour: 100,
          jobTtlSeconds: 600,
          requesterQuestionsPerHour: 10,
        },
      })).resolves.toEqual({ status: "conflict" });

      const effects = new PostgresAnswerEffectStore(isolated.pool);
      const currentReadyBinding = { ...ready, deliveryContainerId: threadContainerId };
      const currentReadyPayload = answerPayload(threadContainerId, ready.questionId);
      const payloads: AnswerPayloadPort = {
        prepare: () => ({
          bindingHash: sha256(canonical(currentReadyBinding)),
          legacyBindingHash: sha256(canonical(ready)),
          payloadBytes: currentReadyPayload,
          payloadHash: sha256(currentReadyPayload),
        }),
      };
      const creates: string[] = [];
      const inspections: string[] = [];
      const delivery: AnswerDeliveryPort = {
        create: (input) => {
          creates.push(input.deliveryContainerId);
          return Promise.resolve("999999999999999999");
        },
        inspect: (input) => {
          inspections.push(input.deliveryContainerId);
          return Promise.resolve({ status: "unconfirmed" });
        },
        remove: () => Promise.resolve(),
      };
      const publication = new DurableAnswerPublication({ delivery, payloads, store: effects });
      await expect(effects.reserve({
        authorizationDigest: ready.authorizationDigest,
        bindingHash: sha256(canonical({
          ...currentReadyBinding,
          deliveryContainerId: parentContainerId,
        })),
        deliveryContainerId: parentContainerId,
        effectId: `meeting-knowledge-answer:v1:${ready.questionId}`,
        legacyBindingHash: sha256(canonical(ready)),
        marker: `marker-${ready.questionId}`,
        payloadBytes: legacyReadyPayload,
        payloadHash: sha256(legacyReadyPayload),
        projectionTargetContainerId: parentContainerId,
        questionFence: {
          generation: thirdLease?.generation ?? 0,
          jobId: ready.questionId,
        },
        replyToRemoteMessageId: ready.questionId,
        sourceMeetingIds: [ready.meetingId],
      })).resolves.toEqual({ status: "conflict" });
      await expect(publication.reserve({
        authorizationDigest: ready.authorizationDigest,
        binding: currentReadyBinding,
        content: "Recovered answer",
        deliveryContainerId: threadContainerId,
        marker: `marker-${ready.questionId}`,
        projectionTargetContainerId: parentContainerId,
        questionGeneration: thirdLease?.generation ?? 0,
        replyToRemoteMessageId: ready.questionId,
        sourceMeetingIds: [ready.meetingId],
      })).resolves.toEqual({
        effectId: `meeting-knowledge-answer:v1:${ready.questionId}`,
        status: "reserved",
      });
      await expect(effects.findById(`meeting-knowledge-answer:v1:${ready.questionId}`))
        .resolves.toMatchObject({
          bindingHash: sha256(canonical(currentReadyBinding)),
          deliveryContainerId: threadContainerId,
          payloadBytes: currentReadyPayload,
          state: "reserved",
        });
      await expect(publication.send({
        authorizationDigest: ready.authorizationDigest,
        effectId: `meeting-knowledge-answer:v1:${ready.questionId}`,
        workerId: "publisher-upgrade",
      })).resolves.toEqual({
        externalReceipt: "999999999999999999",
        status: "delivered",
      });
      expect(creates).toEqual([threadContainerId]);

      const reconciliation = await effects.listOutcomeUnknown(10);
      expect(reconciliation).toHaveLength(1);
      expect(reconciliation[0]).toMatchObject({
        deliveryContainerId: parentContainerId,
        effectId: `meeting-knowledge-answer:v1:${unknown.questionId}`,
        payloadBytes: legacyUnknownPayload,
      });
      await expect(publication.reconcileUnknown(10)).resolves.toEqual({
        absentUnconfirmed: 1,
        delivered: 0,
      });
      expect(inspections).toEqual([parentContainerId]);
      expect(creates).toHaveLength(1);
    } finally {
      await isolated.dispose();
    }
  }, 30_000);
});
