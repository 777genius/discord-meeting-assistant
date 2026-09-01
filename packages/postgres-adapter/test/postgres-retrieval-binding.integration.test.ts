import {
  QuestionBinding,
  isLegacyQuestionBinding,
  type QuestionBindingSnapshot,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { describe, expect, it } from "vitest";

import {
  PostgresAnswerEffectStore,
  PostgresQuestionAdmissionCommit,
  PostgresQuestionJobStore,
} from "../src/index.js";
import {
  preCanonicalProtocol2QuestionAdmissionBindingHash,
  questionAdmissionBindingHash,
} from
  "../src/postgres-meeting-knowledge-codecs.js";
import {
  databaseOrSkip,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

const policy = Object.freeze({
  authorizationPolicyVersion: "discord.participant-current-results.v2",
  policyEpoch: 3,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v3",
});
const oldBinaryPolicy = Object.freeze({ ...policy, policyEpoch: 2 });
const RETRIEVAL_BINDING_TEST_TIMEOUT_MS = 30_000;

function binding(questionId: string, current: boolean): QuestionBindingSnapshot {
  const base = {
    authorizationDigest: "a".repeat(64),
    authorizationPolicyVersion: policy.authorizationPolicyVersion,
    authorizationPrincipalRef: `principal:${questionId}`,
    botApplicationIdentity: "bot-1",
    canonicalEvidenceHash: "b".repeat(64),
    deliveryContainerId: "question-thread-1",
    expectedLocale: "en" as const,
    finalProjectionEpoch: "projection-r1",
    finalProjectionReceipt: `receipt:${questionId}`,
    humanActorIds: ["speaker-a"],
    meetingId: `meeting:${questionId}`,
    meetingRevision: 1,
    memoryGeneration: `focused-memory:v1:${"b".repeat(64)}`,
    policyVersion: policy.policyVersion,
    projectionTargetContainerId: "results-1",
    questionHash: "c".repeat(64),
    questionId,
    requesterSubject: "d".repeat(64),
    roomId: "room-1",
    scopeId: "scope-1",
    transcriptId: `transcript:${questionId}`,
    transcriptVersion: 1,
  };
  return QuestionBinding.create(current
    ? {
        ...base,
        bindingProtocolVersion: 2,
        retrievalBinding: {
          canonicalEvidenceFilters: {
            relativeTimeInterval: null,
            requiresSpeakerMatch: false,
            speakerIds: [],
          },
          compositeProfile: {
            candidatePolicy: "bounded_lane_round_robin_dedupe.v1",
            interleavePolicy: "local_then_historical_per_rank.v1",
            profileId: "meeting-knowledge.composite-retrieval.v1",
          },
          cutoverEpoch: "cutover-r1",
          localCurrentIdentity: {
            algorithmId: "canonical_local_exact_lexical_v1",
            profileFingerprint: "2".repeat(64),
            profileId: "meeting-knowledge.local-current.v2",
          },
          originalQuestion: "Question?",
          profileFingerprint: "e".repeat(64),
          provenanceSchemaVersion: 1,
          request: {
            binding: { capabilityFingerprint: "f".repeat(64),
              contractVersion: "context-retrieval.v2",
              indexProfileDigest: "1".repeat(64), profileId: "profile-v2",
              rankingPolicy: "weighted_rrf_canonical_preferences.v1",
              requiredProviderLanes: ["postgres_keyword", "qdrant_dense"],
              serviceRevision: "revision-v2" },
            budgets: { candidateLimit: 100, deadlineMs: 1_000,
              evidenceByteLimit: 16_000, neighborRadius: 0,
              responseByteLimit: 16_384, resultLimit: 10 },
            filters: { actorKeys: [], category: null, documentKeys: [],
              excludedSourceKeys: [], kinds: ["record_block"],
              relativeTimeInterval: null, sourceGenerations: [{
                projectionGeneration: "generation-1", sourceKey: "source-1" }],
              tagsAll: [], tagsAny: [], tagsNone: [], timeInterval: null },
            queries: [{ query: "Question?", queryId: "question-01" }],
            schemaVersion: 2,
            scope: { memoryScopeId: "scope-opaque", spaceId: "space-opaque",
              threadId: null },
            softPreferences: { actorPreferences: [], relativeTimeInterval: null,
              sourcePreferences: [], timeInterval: null, timeWeightMicros: null },
          },
          retrievalPath: "infinity_locator_v2",
        },
      }
    : base).toSnapshot();
}

async function insertJob(
  database: ReturnType<typeof databaseOrSkip>,
  persistedBinding: QuestionBindingSnapshot,
  bindingJson: unknown = persistedBinding,
  bindingHash: string = questionAdmissionBindingHash(persistedBinding),
): Promise<void> {
  await database.query(
    `INSERT INTO meeting_knowledge.question_jobs (
       question_id, requester_subject, question_hash, scope_id,
       final_projection_receipt, authorization_principal_ref,
       authorization_digest, locale, question_text, binding, binding_hash,
       policy_epoch, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'en', 'Question?', $8::jsonb, $9, $10,
       transaction_timestamp() + interval '10 minutes'
     )`,
    [
      persistedBinding.questionId,
      persistedBinding.requesterSubject,
      persistedBinding.questionHash,
      persistedBinding.scopeId,
      persistedBinding.finalProjectionReceipt,
      persistedBinding.authorizationPrincipalRef,
      persistedBinding.authorizationDigest,
      bindingJson,
      bindingHash,
      policy.policyEpoch,
    ],
  );
}

usePostgresIntegrationDatabase();

describe("PostgreSQL immutable retrieval binding leases", () => {
  it("admits only exact duplicate hashes across the protocol-2 rolling upgrade", async (context) => {
    const database = databaseOrSkip(context);
    const admissions = new PostgresQuestionAdmissionCommit(database, "bot-1", policy);
    const cases = [
      { expected: "duplicate", hash: "canonical" },
      { expected: "duplicate", hash: "pre-canonical-protocol-2" },
      { expected: "conflict", hash: "different-valid-binding" },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const current = binding(`rolling-admission-${String(index)}`, true);
      const preCanonicalHash = preCanonicalProtocol2QuestionAdmissionBindingHash(current);
      if (preCanonicalHash === null || current.bindingProtocolVersion !== 2) {
        throw new Error("rolling admission fixture must use protocol 2");
      }
      const differentBinding = QuestionBinding.create({
        ...current,
        retrievalBinding: {
          ...current.retrievalBinding,
          cutoverEpoch: "different-valid-cutover",
        },
      }).toSnapshot();
      const storedHash = testCase.hash === "canonical"
        ? questionAdmissionBindingHash(current)
        : testCase.hash === "pre-canonical-protocol-2"
          ? preCanonicalHash
          : questionAdmissionBindingHash(differentBinding);
      await insertJob(database, current, current, storedHash);

      await expect(admissions.commit({
        authorization: {
          actorId: current.humanActorIds[0] ?? "speaker-a",
          containerId: current.projectionTargetContainerId,
          deliveryContainerId: current.deliveryContainerId,
          digest: current.authorizationDigest,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          observedAt: new Date().toISOString(),
          policyVersion: current.authorizationPolicyVersion,
          scopeId: current.scopeId,
          source: "authoritative_remote",
          status: "authorized",
        },
        binding: current,
        questionText: "Is this the exact same Discord admission?",
        ratePolicy: {
          guildQuestionsPerHour: 10,
          jobTtlSeconds: 900,
          requesterQuestionsPerHour: 3,
        },
      })).resolves.toEqual(testCase.expected === "duplicate"
        ? { jobId: current.questionId, status: "duplicate" }
        : { status: "conflict" });
    }
  });

  it("fences old-binary admission after the binding-aware epoch activates", async (context) => {
    const database = databaseOrSkip(context);
    const currentJobs = new PostgresQuestionJobStore(database, policy);
    await expect(currentJobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "binding-aware-activation-worker",
    })).resolves.toBeNull();

    const current = binding("old-binary-admission-question", true);
    const oldAdmissions = new PostgresQuestionAdmissionCommit(
      database,
      current.botApplicationIdentity,
      oldBinaryPolicy,
    );
    await expect(oldAdmissions.commit({
      authorization: {
        actorId: current.humanActorIds[0] ?? "speaker-a",
        containerId: current.projectionTargetContainerId,
        deliveryContainerId: current.deliveryContainerId,
        digest: current.authorizationDigest,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        observedAt: new Date().toISOString(),
        policyVersion: current.authorizationPolicyVersion,
        scopeId: current.scopeId,
        source: "authoritative_remote",
        status: "authorized",
      },
      binding: current,
      questionText: "Can an old binary admit this binding?",
      ratePolicy: {
        guildQuestionsPerHour: 10,
        jobTtlSeconds: 900,
        requesterQuestionsPerHour: 3,
      },
    })).resolves.toEqual({ status: "stale" });
    await expect(database.query(
      "SELECT 1 FROM meeting_knowledge.question_jobs WHERE question_id = $1",
      [current.questionId],
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("drains legacy without duplicate provider or publication effects", async (context) => {
    const database = databaseOrSkip(context);
    const jobs = new PostgresQuestionJobStore(database, policy);

    const legacy = binding("legacy-active-question", false);
    await insertJob(database, legacy);
    const legacyLease = await jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "legacy-drain-worker",
    });
    expect(legacyLease?.binding).toEqual(legacy);
    if (legacyLease === null) {
      throw new Error("pre-cutover active job was not leased for drain");
    }
    expect(isLegacyQuestionBinding(legacyLease.binding)).toBe(true);
    await expect(jobs.persistGroundingPlan({
      attemptAlreadyReserved: false,
      attemptId: `legacy-attempt-1`,
      binding: legacy,
      generation: legacyLease.generation,
      jobId: legacy.questionId,
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      measurement: { inputTokens: 10, requestBytes: 100 },
      plan: groundingPlan(),
      question: "Question?",
      runtimeProfile: "legacy-drain-test",
      sourceMeetingIds: [legacy.meetingId],
    })).resolves.toBe(true);
    await expect(jobs.reserveProviderAttempt({
      attemptId: "legacy-attempt-1",
      generation: legacyLease.generation,
      jobId: legacy.questionId,
      leaseSeconds: 240,
      maximumProviderAttempts: 2,
    })).resolves.toBe(false);
    await expect(jobs.failProviderAttempt({
      attemptId: "legacy-attempt-1",
      generation: legacyLease.generation,
      jobId: legacy.questionId,
      maximumProviderAttempts: 2,
      reason: "retryable_provider_failure",
      retryable: true,
    })).resolves.toBe("deferred");
    const legacyTakeover = await jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "legacy-takeover-worker",
    });
    expect(legacyTakeover).toMatchObject({
      binding: legacy,
      generation: legacyLease.generation + 1,
      state: "running",
    });
    if (legacyTakeover === null) {
      throw new Error("pre-cutover job was not taken over after provider failure");
    }
    await expect(jobs.reserveProviderAttempt({
      attemptId: "legacy-attempt-2",
      generation: legacyTakeover.generation,
      jobId: legacy.questionId,
      leaseSeconds: 240,
      maximumProviderAttempts: 2,
    })).resolves.toBe(true);
    await expect(jobs.completeProviderAttempt({
      answerCandidate: answerCandidate(),
      attemptId: "legacy-attempt-2",
      generation: legacyTakeover.generation,
      jobId: legacy.questionId,
    })).resolves.toBe(true);
    await database.query(
      `UPDATE meeting_knowledge.question_jobs
       SET lease_until = transaction_timestamp() - interval '1 second'
       WHERE question_id = $1`,
      [legacy.questionId],
    );
    const legacyReady = await jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "legacy-publication-worker",
    });
    expect(legacyReady).toMatchObject({
      binding: legacy,
      generation: legacyTakeover.generation + 1,
      state: "ready",
    });
    if (legacyReady === null) {
      throw new Error("pre-cutover job was not taken over for publication");
    }
    const effects = new PostgresAnswerEffectStore(database, policy);
    const effectId = `meeting-knowledge-answer:v1:${legacy.questionId}`;
    const effectReservation = {
      authorityScopeId: legacy.scopeId,
      authorizationDigest: legacy.authorizationDigest,
      bindingHash: questionAdmissionBindingHash(legacy),
      deliveryContainerId: legacy.deliveryContainerId,
      effectId,
      marker: effectId,
      payloadBytes: '{"content":"Friday."}',
      payloadHash: "1".repeat(64),
      projectionTargetContainerId: legacy.projectionTargetContainerId,
      questionFence: {
        generation: legacyReady.generation,
        jobId: legacy.questionId,
      },
      replyToRemoteMessageId: legacy.questionId,
      sourceMeetingIds: [legacy.meetingId],
    };
    await expect(effects.reserve(effectReservation)).resolves.toEqual({
      status: "reserved",
    });
    await expect(effects.reserve(effectReservation)).resolves.toEqual({
      status: "existing",
    });
    await expect(effects.startRequest({
      authorizationDigest: legacy.authorizationDigest,
      effectId,
      questionGeneration: legacyReady.generation,
      workerId: "legacy-publication-worker",
    })).resolves.toBe(true);
    await expect(effects.startRequest({
      authorizationDigest: legacy.authorizationDigest,
      effectId,
      questionGeneration: legacyReady.generation,
      workerId: "duplicate-publication-worker",
    })).resolves.toBe(false);
    await expect(effects.complete({
      effectId,
      externalReceipt: "discord-message-legacy-1",
    })).resolves.toBe(true);
    await expect(jobs.settle({
      generation: legacyReady.generation,
      jobId: legacy.questionId,
      outcome: "answered",
    })).resolves.toBe(true);
    await expect(database.query(
      `SELECT attempts, provider_attempt_state
       FROM meeting_knowledge.question_jobs
       WHERE question_id = $1`,
      [legacy.questionId],
    )).resolves.toMatchObject({
      rows: [{ attempts: 2, provider_attempt_state: "completed" }],
    });
    await expect(database.query(
      `SELECT state, external_receipt
       FROM meeting_core.answer_effects
       WHERE effect_id = $1`,
      [effectId],
    )).resolves.toMatchObject({
      rows: [{
        external_receipt: "discord-message-legacy-1",
        state: "delivered",
      }],
    });
  }, RETRIEVAL_BINDING_TEST_TIMEOUT_MS);
});

describe("PostgreSQL binding-aware worker rolling fence", () => {
  it("rejects old running and ready leases and preserves takeover binding", async (context) => {
    const database = databaseOrSkip(context);
    const jobs = new PostgresQuestionJobStore(database, policy);
    const current = binding("current-bound-question", true);
    await insertJob(database, current);
    await expect(database.query(
      `UPDATE meeting_knowledge.question_jobs
       SET binding = binding - 'retrievalBinding'
       WHERE question_id = $1`,
      [current.questionId],
    )).rejects.toThrow("question retrieval binding is immutable");
    await expect(database.query(
      `UPDATE meeting_knowledge.question_jobs
       SET state = 'running', generation = 1, lease_owner = 'legacy-worker',
           lease_until = transaction_timestamp() + interval '1 minute',
           worker_protocol_epoch = 2, worker_protocol_generation = 1
       WHERE question_id = $1`,
      [current.questionId],
    )).rejects.toThrow(
      "question_jobs_retrieval_binding_worker_protocol_is_current",
    );
    const firstLease = await jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "first-worker",
    });
    expect(firstLease?.binding).toEqual(current);
    if (firstLease === null) {
      throw new Error("current binding was not leased");
    }
    await expect(jobs.persistGroundingPlan({
      attemptAlreadyReserved: false,
      attemptId: `current-attempt-1`,
      binding: current,
      generation: firstLease.generation,
      jobId: current.questionId,
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      measurement: { inputTokens: 10, requestBytes: 100 },
      plan: groundingPlan(),
      question: "Question?",
      runtimeProfile: "current-ready-fence-test",
      sourceMeetingIds: [current.meetingId],
    })).resolves.toBe(false);
    const primed = await database.query(
      `UPDATE meeting_knowledge.question_jobs
       SET state = 'ready', grounding_plan = $2::jsonb,
           grounding_measurement = '{"schemaVersion":1,"inputTokens":10,"requestBytes":100}'::jsonb,
           runtime_profile = 'current-ready-fence-test',
           source_meeting_ids = ARRAY[$3]::text[], attempts = 1,
           provider_attempt_state = 'completed',
           provider_attempt_id = 'current-attempt-1',
           provider_attempt_started_at = transaction_timestamp(),
           provider_attempt_finished_at = transaction_timestamp(),
           answer_candidate = $4::jsonb, ready_at = transaction_timestamp(),
           lease_until = transaction_timestamp() - interval '1 second'
       WHERE question_id = $1 AND generation = $5 AND state = 'running'`,
      [current.questionId, groundingPlan(), current.meetingId, answerCandidate(),
        firstLease.generation],
    );
    expect(primed.rowCount).toBe(1);
    await expect(database.query(
      `UPDATE meeting_knowledge.question_jobs
       SET state = 'ready', generation = generation + 1,
           lease_owner = 'old-ready-worker',
           lease_until = transaction_timestamp() + interval '1 minute',
           worker_protocol_epoch = 2,
           worker_protocol_generation = generation + 1
       WHERE question_id = $1`,
      [current.questionId],
    )).rejects.toThrow(
      "question_jobs_retrieval_binding_worker_protocol_is_current",
    );
    const resumedLease = await jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "replacement-worker-with-different-rollout-config",
    });
    expect(resumedLease).toMatchObject({
      binding: current,
      generation: firstLease.generation + 1,
      state: "ready",
    });
    if (resumedLease === null) {
      throw new Error("persisted retrieval binding was not resumed");
    }
    await expect(jobs.settle({
      generation: resumedLease.generation,
      jobId: current.questionId,
      outcome: "unavailable",
    })).resolves.toBe(true);

    const malformedAuthority = binding("malformed-current-question", true);
    const { retrievalBinding: _missing, ...missingRetrieval } = malformedAuthority;
    await insertJob(database, malformedAuthority, missingRetrieval);
    await expect(jobs.leaseNext({
      leaseSeconds: 60,
      maximumProviderAttempts: 2,
      workerId: "fail-closed-worker",
    })).resolves.toBeNull();
    await expect(database.query<{ readonly outcome: string;
      readonly reconciliation_disposition: string; readonly state: string }>(
      `SELECT state, outcome, reconciliation_disposition
       FROM meeting_knowledge.question_jobs WHERE question_id = $1`,
      [malformedAuthority.questionId],
    )).resolves.toMatchObject({ rows: [{ outcome: "stale_binding",
      reconciliation_disposition: "quarantined", state: "terminal" }] });
  }, RETRIEVAL_BINDING_TEST_TIMEOUT_MS);
});

function groundingPlan() {
  return {
    authorityGeneration: `focused-memory:v1:${"b".repeat(64)}`,
    evidence: [{
      endMs: 1,
      evidenceId: "evidence-legacy-1",
      speakerId: "speaker-a",
      startMs: 0,
      text: "Friday.",
      turnHash: "f".repeat(64),
      turnId: "turn-legacy-1",
    }],
    mode: "focused_retrieval" as const,
  };
}

function answerCandidate() {
  return {
    claims: [{ evidenceIds: ["evidence-legacy-1"], text: "Friday." }],
    locale: "en" as const,
    status: "answered" as const,
  };
}
