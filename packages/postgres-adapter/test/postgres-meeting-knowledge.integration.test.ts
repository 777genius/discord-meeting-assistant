import {
  DurableAnswerPublication,
} from "@discord-meeting/meeting-core/publishing";
import {
  LiveFinalizedMemoryWorker,
  createHistoricalReleaseBinding,
  createFocusedRetrievalGroundingPlan,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { LiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import type {
  AnswerPayloadPort,
} from "@discord-meeting/meeting-core/publishing";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PostgresAnswerEffectStore,
  PostgresExhaustiveCoverageStore,
  PostgresFinalReplyMaintenance,
  PostgresFinalReplyEvidence,
  PostgresFocusedMemoryRetrieval,
  PostgresHistoricalEvidenceAuthority,
  PostgresLiveFinalizedMemoryLifecycle,
  PostgresLiveFinalizedMemoryQuery,
  PostgresLiveFinalizedMemoryStore,
  PostgresLiveMeetingRepository,
  PostgresQuestionAdmissionCommit,
  PostgresQuestionJobStore,
  canonicalFinalReplyTurnHash,
} from "../src/index.js";
import {
  databaseOrSkip,
  evidenceBackedMeeting,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

const botId = "11111111111111111";
const channelId = "22222222222222222";
const finalMessageId = "33333333333333333";
const questionId = "44444444444444444";
const questionPolicy = Object.freeze({
  authorizationPolicyVersion: "discord.participant-current-results.v1",
  policyEpoch: 1,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const testPayloadCodec: AnswerPayloadPort = {
  prepare: (input) => {
    const payloadBytes = JSON.stringify({
      content: input.content,
      marker: input.marker,
      projectionTargetContainerId: input.projectionTargetContainerId,
      replyToRemoteMessageId: input.replyToRemoteMessageId,
      schemaVersion: 1,
    });
    return {
      bindingHash: digest(JSON.stringify(input.binding)),
      payloadBytes,
      payloadHash: digest(payloadBytes),
    };
  },
};

usePostgresIntegrationDatabase();

async function waitForBlockedHistoricalBackend(
  database: ReturnType<typeof databaseOrSkip>,
): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await database.query<{ readonly pid: number }>(`
      SELECT pid::float8 AS pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query LIKE '%SELECT revision::float8 AS revision, snapshot%'
      ORDER BY pid
      LIMIT 1
    `);
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) {
      return pid;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("historical PostgreSQL query did not reach its controlled lock");
}

async function backendIsActive(
  database: ReturnType<typeof databaseOrSkip>,
  backendPid: number,
): Promise<boolean> {
  const result = await database.query<{ readonly active: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active'
    ) AS active
  `, [backendPid]);
  return result.rows[0]?.active === true;
}

async function persistPublishedMeeting(
  database: ReturnType<typeof databaseOrSkip>,
) {
  const meeting = evidenceBackedMeeting("meeting-knowledge-1", channelId);
  const snapshotBeforePublication = meeting.toSnapshot();
  meeting.beginPublication();
  meeting.completePublication({
    externalPublicationId:
      `discord:v2:channel:${channelId}:message:${finalMessageId}`,
    idempotencyKey: meeting.publicationIdempotencyKey(),
    publisherIdentity: botId,
  });
  const snapshot = meeting.toSnapshot();
  await database.query(
    `
      INSERT INTO meeting_core.meetings (meeting_id, revision, snapshot)
      VALUES ($1, $2, $3::jsonb)
    `,
    [snapshot.meetingId, snapshot.revision, snapshot],
  );
  return { snapshot, snapshotBeforePublication };
}

async function persistRunningAnswerJob(
  database: ReturnType<typeof databaseOrSkip>,
  binding: {
    readonly authorizationDigest: string;
    readonly finalProjectionReceipt: string;
    readonly questionHash: string;
    readonly questionId: string;
    readonly requesterSubject: string;
    readonly scopeId: string;
  },
): Promise<void> {
  await database.query(
    `INSERT INTO meeting_knowledge.question_jobs (
       question_id, requester_subject, question_hash, scope_id,
       final_projection_receipt, authorization_principal_ref,
       authorization_digest, locale, question_text, binding, binding_hash,
       state, generation, lease_owner, lease_until,
       worker_protocol_epoch, worker_protocol_generation, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'opaque', $6, 'en', 'Question?', $7::jsonb,
       $8, 'running', 1, 'worker-1',
       transaction_timestamp() + interval '1 minute',
       2, 1,
       transaction_timestamp() + interval '10 minutes'
     )`,
    [
      binding.questionId,
      binding.requesterSubject,
      binding.questionHash,
      binding.scopeId,
      binding.finalProjectionReceipt,
      binding.authorizationDigest,
      binding,
      "f".repeat(64),
    ],
  );
}

describe("PostgreSQL Local Final Reply adapters", () => {
  it("atomically binds, deduplicates, leases, readies, and scrubs one current job", async (context) => {
    const database = databaseOrSkip(context);
    await persistPublishedMeeting(database);
    const evidence = new PostgresFinalReplyEvidence(database, botId);
    const authority = await evidence.findCurrentBinding({
      finalProjectionReceipt:
        `discord:v2:channel:${channelId}:message:${finalMessageId}`,
      projectionTargetContainerId: channelId,
    });
    expect(authority).not.toBeNull();
    if (authority === null) {
      return;
    }
    const binding = {
      authorizationDigest: "a".repeat(64),
      authorizationPolicyVersion: "discord.participant-current-results.v1",
      authorizationPrincipalRef: "opaque-principal",
      bindingProtocolVersion: 2 as const,
      botApplicationIdentity: authority.botApplicationIdentity,
      canonicalEvidenceHash: authority.canonicalEvidenceHash,
      deliveryContainerId: channelId,
      expectedLocale: "en" as const,
      finalProjectionEpoch: authority.finalProjectionEpoch,
      finalProjectionReceipt: authority.finalProjectionReceipt,
      humanActorIds: authority.humanActorIds,
      meetingId: authority.meetingId,
      meetingRevision: authority.meetingRevision,
      memoryGeneration: authority.memoryGeneration,
      policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
      projectionTargetContainerId: authority.projectionTargetContainerId,
      questionHash: "b".repeat(64),
      questionId,
      requesterSubject: "c".repeat(64),
      retrievalBinding: {
        cutoverEpoch: "cutover-r1",
        profileFingerprint: "e".repeat(64),
        retrievalPath: "legacy_downstream_v1" as const,
      },
      roomId: authority.roomId,
      scopeId: authority.scopeId,
      transcriptId: authority.transcriptId,
      transcriptVersion: authority.transcriptVersion,
    };
    const authorization = {
      actorId: "speaker-a",
      containerId: channelId,
      deliveryContainerId: channelId,
      digest: binding.authorizationDigest,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      observedAt: new Date().toISOString(),
      policyVersion: binding.authorizationPolicyVersion,
      scopeId: binding.scopeId,
      source: "authoritative_remote" as const,
      status: "authorized" as const,
    };
    const admissions = new PostgresQuestionAdmissionCommit(database, botId, questionPolicy);
    const command = {
      authorization,
      binding,
      questionText: "When is the first release?",
      ratePolicy: {
        guildQuestionsPerHour: 10,
        jobTtlSeconds: 900,
        requesterQuestionsPerHour: 3,
      },
    };
    const concurrentAdmissions = await Promise.all([
      admissions.commit(command),
      admissions.commit({
        ...command,
        binding: {
          ...binding,
          authorizationPrincipalRef: "concurrent-opaque-principal",
        },
      }),
    ]);
    expect(concurrentAdmissions.toSorted((left, right) =>
      left.status.localeCompare(right.status)
    )).toEqual([
      { jobId: questionId, status: "committed" },
      { jobId: questionId, status: "duplicate" },
    ]);

    const jobs = new PostgresQuestionJobStore(database, questionPolicy);
    const lease = await jobs.leaseNext({ leaseSeconds: 60, maximumProviderAttempts: 2, workerId: "worker-1" });
    expect(lease).toMatchObject({
      binding: { retrievalBinding: binding.retrievalBinding },
      generation: 1,
      jobId: questionId,
      state: "running",
    });
    if (lease === null) {
      return;
    }
    const retrievalAdapter = new PostgresFocusedMemoryRetrieval(database, botId);
    const retrievalInput = {
      canonicalEvidenceHash: binding.canonicalEvidenceHash,
      expectedAuthorityGeneration: binding.memoryGeneration,
      finalProjectionReceipt: binding.finalProjectionReceipt,
      maximumCandidates: 24,
      meetingId: binding.meetingId,
      meetingRevision: binding.meetingRevision,
      neighborTurns: 0,
      projectionTargetContainerId: binding.projectionTargetContainerId,
      question: command.questionText,
      roomId: binding.roomId,
      scopeId: binding.scopeId,
      transcriptId: binding.transcriptId,
      transcriptVersion: binding.transcriptVersion,
    };
    await expect(retrievalAdapter.retrieve({
      ...retrievalInput,
      neighborTurns: 8,
    })).resolves.toEqual({ schemaVersion: 1, status: "low_coverage" });
    const retrieval = await retrievalAdapter.retrieve(retrievalInput);
    expect(retrieval.status).toBe("current");
    if (retrieval.status !== "current") {
      return;
    }
    const hydrated = await evidence.rehydrateSelectedEvidence(
      binding,
      retrieval.candidates,
    );
    expect(hydrated.status).toBe("current");
    if (hydrated.status !== "current") {
      return;
    }
    expect(hydrated.turns.map(({ turnId }) => turnId)).toEqual([
      "turn-decision",
      "turn-action",
    ]);
    const plan = createFocusedRetrievalGroundingPlan({
      authorityGeneration: retrieval.authorityGeneration,
      coverage: "sufficient",
      humanActorIds: hydrated.binding.humanActorIds,
      turns: hydrated.turns,
    });
    expect(await jobs.persistGroundingPlan({
      generation: lease.generation,
      jobId: lease.jobId,
      measurement: { inputTokens: 1_000, requestBytes: 4_000 },
      plan,
      runtimeProfile: "sol-medium-test",
      sourceMeetingIds: [binding.meetingId],
    })).toBe(true);
    const providerAttemptId =
      `${lease.jobId}:generation:${lease.generation}:attempt:1`;
    expect(await jobs.reserveProviderAttempt({
      attemptId: providerAttemptId,
      generation: lease.generation,
      jobId: lease.jobId,
      leaseSeconds: 240,
      maximumProviderAttempts: 2,
    })).toBe(true);
    await expect(jobs.leaseNext({
      leaseSeconds: 240,
      maximumProviderAttempts: 2,
      workerId: "competing-worker",
    })).resolves.toBeNull();
    expect(await jobs.completeProviderAttempt({
      answerCandidate: {
        claims: [{ evidenceIds: ["evidence-000001"], text: "Friday." }],
        locale: "en",
        status: "answered",
      },
      attemptId: providerAttemptId,
      generation: lease.generation,
      jobId: lease.jobId,
    })).toBe(true);
    await database.query(
      `
        UPDATE meeting_knowledge.question_jobs
        SET lease_until = transaction_timestamp() - interval '1 second'
        WHERE question_id = $1
      `,
      [questionId],
    );
    const ready = await jobs.leaseNext({ leaseSeconds: 60, maximumProviderAttempts: 2, workerId: "worker-2" });
    expect(ready).toMatchObject({
      binding: { retrievalBinding: binding.retrievalBinding },
      generation: 2,
      state: "ready",
    });
    expect(await jobs.settle({
      generation: ready?.generation ?? 0,
      jobId: questionId,
      outcome: "answered",
    })).toBe(true);
    await expect(admissions.commit({
      ...command,
      binding: {
        ...binding,
        authorizationPrincipalRef: "new-opaque-principal-for-duplicate-event",
      },
    })).resolves.toEqual({
      jobId: questionId,
      status: "duplicate",
    });
    await expect(admissions.commit({
      ...command,
      binding: {
        ...binding,
        retrievalBinding: {
          cutoverEpoch: "rollback-r2",
          profileFingerprint: "f".repeat(64),
          retrievalPath: "legacy_downstream_v1" as const,
        },
      },
    })).resolves.toEqual({ status: "conflict" });
    const stored = await database.query(`
      SELECT authorization_principal_ref, question_text, binding, grounding_plan,
             answer_candidate, state, outcome
      FROM meeting_knowledge.question_jobs
      WHERE question_id = $1
    `, [questionId]);
    expect(stored.rows[0]).toEqual({
      answer_candidate: null,
      authorization_principal_ref: null,
      binding: null,
      grounding_plan: null,
      outcome: "answered",
      question_text: null,
      state: "terminal",
    });

  });

});

describe("PostgreSQL answer effect recovery", () => {
  it("durably fences an ambiguous answer create from every retry", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresAnswerEffectStore(database, questionPolicy);
    let creates = 0;
    const publication = new DurableAnswerPublication({
      delivery: {
        create: () => {
          creates += 1;
          return Promise.reject(new Error("ambiguous timeout"));
        },
        inspect: () => Promise.resolve({ status: "unconfirmed" as const }),
        remove: () => Promise.resolve(),
      },
      payloads: testPayloadCodec,
      store,
    });
    const binding = {
      authorizationDigest: "a".repeat(64),
      authorizationPolicyVersion: "discord.participant-current-results.v1",
      authorizationPrincipalRef: "opaque",
      botApplicationIdentity: botId,
      canonicalEvidenceHash: "b".repeat(64),
      deliveryContainerId: channelId,
      expectedLocale: "en" as const,
      finalProjectionEpoch: "epoch-1",
      finalProjectionReceipt: `discord:v2:channel:${channelId}:message:${finalMessageId}`,
      humanActorIds: ["55555555555555555"],
      meetingId: "meeting-1",
      meetingRevision: 1,
      memoryGeneration: `focused-memory:v1:${"b".repeat(64)}`,
      policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
      projectionTargetContainerId: channelId,
      questionHash: "c".repeat(64),
      questionId,
      requesterSubject: "d".repeat(64),
      roomId: "55555555555555555",
      scopeId: "66666666666666666",
      transcriptId: "transcript-1",
      transcriptVersion: 1,
    };
    await persistRunningAnswerJob(database, binding);
    const reservation = await publication.reserve({
      authorizationDigest: binding.authorizationDigest,
      binding,
      content: "Answer with citation.",
      deliveryContainerId: channelId,
      marker: "meeting-knowledge-answer:v1:question-1",
      projectionTargetContainerId: channelId,
      questionGeneration: 1,
      replyToRemoteMessageId: questionId,
      sourceMeetingIds: [binding.meetingId],
    });
    await expect(publication.send({
      authorizationDigest: binding.authorizationDigest,
      effectId: reservation.effectId,
      questionGeneration: 1, workerId: "worker-1",
    })).resolves.toEqual({ status: "outcome_unknown" });
    await expect(publication.send({
      authorizationDigest: binding.authorizationDigest,
      effectId: reservation.effectId,
      questionGeneration: 1, workerId: "worker-2",
    })).resolves.toEqual({ status: "outcome_unknown" });
    await publication.reconcileUnknown(100);
    expect(creates).toBe(1);
  });
});

describe("PostgreSQL exhaustive coverage checkpoints", () => {
  it("replays a completed bitmap and reduction without reopening the lease", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresExhaustiveCoverageStore(database);
    const release = createHistoricalReleaseBinding({
      acceptedMeetingRevision: 7,
      desiredGeneration: 1,
      meetingId: "checkpoint-meeting",
      roomId: "checkpoint-room",
      scopeId: "checkpoint-scope",
      transcriptId: "checkpoint-transcript",
      transcriptVersion: 2,
    });
    const identity = {
      blockLocators: ["mkcandidate1.block-0"],
      checkpointId: "mkcoverage1.completed-replay",
      planDigest: "a".repeat(64),
      questionHash: "b".repeat(64),
      releaseBindings: [release],
      retentionSeconds: 86_400,
    };
    const lease = await store.open(identity);
    const extracted = await store.recordExtract({
      blockOrdinal: 0,
      checkpointId: lease.checkpointId,
      extract: {
        blockLocator: identity.blockLocators[0]!,
        evidenceLocators: [identity.blockLocators[0]!],
        payload: { mentions: 1 },
        selectedTurns: [{
          blockLocator: identity.blockLocators[0]!,
          relevance: "direct",
          sourceEndCodePoint: 18,
          sourceRef: "checkpoint-source-1",
          sourceStartCodePoint: 0,
          turnId: "checkpoint-turn-1",
        }],
        selectionStatus: "selected",
        schemaVersion: 1,
      },
      fence: lease.fence,
    });
    const reduction = {
      evidenceLocators: [identity.blockLocators[0]!],
      payload: { mentions: 1 },
      selectedTurns: [{
        blockLocator: identity.blockLocators[0]!,
        relevance: "direct" as const,
        sourceEndCodePoint: 18,
        sourceRef: "checkpoint-source-1",
        sourceStartCodePoint: 0,
        turnId: "checkpoint-turn-1",
      }],
      selectionStatus: "selected" as const,
      schemaVersion: 1 as const,
    };
    await store.recordReduction({
      checkpointId: extracted.checkpointId,
      fence: extracted.fence,
      reduction,
    });
    await store.complete({ checkpointId: extracted.checkpointId, fence: extracted.fence });

    await expect(store.open(identity)).resolves.toMatchObject({
      attempt: lease.attempt,
      bitmap: [true],
      fence: lease.fence,
      reduction,
      state: "completed",
    });
  });
});

describe("PostgreSQL historical server cancellation", () => {
  it("cancels and removes an in-flight backend before returning the abort reason", async (context) => {
    const database = databaseOrSkip(context);
    const lockOwner = await database.connect();
    const binding = createHistoricalReleaseBinding({
      acceptedMeetingRevision: 1,
      desiredGeneration: 1,
      meetingId: "controlled-cancellation-meeting",
      roomId: "controlled-cancellation-room",
      scopeId: "controlled-cancellation-scope",
      transcriptId: "controlled-cancellation-transcript",
      transcriptVersion: 1,
    });
    try {
      await lockOwner.query("BEGIN");
      await lockOwner.query(
        "LOCK TABLE meeting_core.meetings IN ACCESS EXCLUSIVE MODE",
      );
      const controller = new AbortController();
      const cancellation = new Error("synthetic historical request cancelled");
      const operation = new PostgresHistoricalEvidenceAuthority(database)
        .loadAcceptedFinalMeeting(binding, { signal: controller.signal });
      const backendPid = await waitForBlockedHistoricalBackend(database);

      controller.abort(cancellation);

      await expect(operation).rejects.toBe(cancellation);
      await expect(backendIsActive(database, backendPid)).resolves.toBe(false);
    } finally {
      await lockOwner.query("ROLLBACK").catch(() => {});
      lockOwner.release(true);
    }
  });
});

describe("PostgreSQL question job cleanup", () => {
  it("expires and scrubs a job independently after its answer request became ambiguous", async (context) => {
    const database = databaseOrSkip(context);
    const expiredQuestionId = "77777777777777777";
    await database.query(
      `
        INSERT INTO meeting_knowledge.question_jobs (
          question_id, requester_subject, question_hash, scope_id,
          final_projection_receipt, authorization_principal_ref,
          authorization_digest, locale, question_text, binding, binding_hash,
          created_at, expires_at
        ) VALUES (
          $1, $2, $3, 'scope-1', 'projection-1', 'opaque-principal',
          $4, 'en', 'Sensitive question?', '{}'::jsonb, $5,
          transaction_timestamp() - interval '2 minutes',
          transaction_timestamp() - interval '1 minute'
        )
      `,
      [
        expiredQuestionId,
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
      ],
    );
    await database.query(
      `
        INSERT INTO meeting_core.answer_effects (
          effect_id, state, authority_scope_id, projection_target_container_id,
          delivery_container_id, reply_to_remote_message_id, marker,
          payload_bytes, payload_hash,
          binding_hash, authorization_digest, source_meeting_ids,
          request_started_at
        ) VALUES (
          $1, 'outcome_unknown', 'scope-1', $2, $2, $3, 'marker-1', '{"content":"sensitive"}',
          $4, $5, $6, ARRAY['source-meeting-1']::text[],
          transaction_timestamp() - interval '90 seconds'
        )
      `,
      [
        `meeting-knowledge-answer:v1:${expiredQuestionId}`,
        channelId,
        expiredQuestionId,
        "e".repeat(64),
        "f".repeat(64),
        "c".repeat(64),
      ],
    );

    const maintenance = new PostgresFinalReplyMaintenance(database, questionPolicy);
    await expect(maintenance.maintain({ maximumJobs: 1, servingEnabled: true }))
      .resolves.toEqual({ cancelled: 0, expired: 1 });
    const stored = await database.query(
      `
        SELECT authorization_principal_ref, question_text, binding, state, outcome
        FROM meeting_knowledge.question_jobs
        WHERE question_id = $1
      `,
      [expiredQuestionId],
    );
    expect(stored.rows[0]).toEqual({
      authorization_principal_ref: null,
      binding: null,
      outcome: "delivery_unknown",
      question_text: null,
      state: "terminal",
    });
  });
});

describe("PostgreSQL live finalized memory", () => {
  it("backfills after restart, projects atomically, rehydrates locally, and denies cross-room reads", async (context) => {
    const database = databaseOrSkip(context);
    const meetingId = "live-memory-postgres-1";
    const repository = new PostgresLiveMeetingRepository(database);
    await repository.save(LiveMeeting.start({
      meetingId,
      publicationTargetId: channelId,
      startedAtMs: 0,
    }).toSnapshot(), null);
    const firstTurn = {
      endMs: 2_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "The cedar launch is Friday.",
      turnId: "live-memory-turn-1",
    };

    // A finalized turn may survive a process restart before trusted lifecycle
    // registration; registration deterministically backfills it exactly once.
    await expect(repository.appendFinalizedTurn(meetingId, firstTurn))
      .resolves.toBe("appended");
    const lifecycle = new PostgresLiveFinalizedMemoryLifecycle(database);
    const identity = {
      actors: [{ actorId: "speaker-a", kind: "human" as const }],
      identityProvenance: {
        actorObservationState: "consistent" as const,
        actorSemanticsVersion: 1,
        producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
        producerRevision: "producer-r1",
        rosterState: "unsealed" as const,
      },
      lifecycleGeneration: 3,
      meetingId,
      roomId: "room-live-1",
      scopeId: "scope-live-1",
    };
    await expect(lifecycle.registerMeeting(identity)).resolves.toBe("accepted");
    await expect(lifecycle.registerMeeting(identity)).resolves.toBe("replayed");
    const projected = await database.query(`
      SELECT mutation_id, state, source_generation::integer AS source_generation
      FROM meeting_knowledge.live_memory_outbox
      WHERE meeting_id = $1
    `, [meetingId]);
    expect(projected.rows).toHaveLength(1);
    expect(projected.rows[0]).toMatchObject({ source_generation: 1, state: "pending" });

    const worker = new LiveFinalizedMemoryWorker(
      new PostgresLiveFinalizedMemoryStore(database),
      { hash: canonicalFinalReplyTurnHash },
    );
    await expect(worker.executeOnce({ meetingId })).resolves.toMatchObject({
      status: "applied",
    });
    const contextTurns = [
      {
        endMs: 4_000,
        speakerId: "speaker-a",
        startMs: 3_000,
        text: "The support rotation remains unchanged.",
        turnId: "live-memory-turn-2",
      },
      {
        endMs: 6_000,
        speakerId: "speaker-a",
        startMs: 5_000,
        text: "The design review is next Tuesday.",
        turnId: "live-memory-turn-3",
      },
    ];
    for (const turn of contextTurns) {
      await expect(repository.appendFinalizedTurn(meetingId, turn))
        .resolves.toBe("appended");
      await expect(worker.executeOnce({ meetingId })).resolves.toMatchObject({
        status: "applied",
      });
    }
    const query = new PostgresLiveFinalizedMemoryQuery(database);
    await expect(query.searchHotTail({
      maximumCandidates: 8,
      meetingId,
      neighborTurns: 8,
      question: "When is the cedar launch?",
      requesterActorId: "speaker-a",
      roomId: "room-live-1",
      scopeId: "scope-live-1",
    })).resolves.toEqual({ schemaVersion: 1, status: "low_coverage" });
    const selected = await query.searchHotTail({
      maximumCandidates: 8,
      meetingId,
      neighborTurns: 0,
      question: "cedar launch",
      requesterActorId: "speaker-a",
      roomId: "room-live-1",
      scopeId: "scope-live-1",
    });
    expect(selected.status).toBe("current");
    if (selected.status !== "current") {
      return;
    }
    await expect(query.rehydrateHotTail({
      candidates: selected.candidates,
      expectedGeneration: selected.context.sourceGeneration,
      meetingId,
      requesterActorId: "speaker-a",
      roomId: "room-live-1",
      scopeId: "scope-live-1",
    })).resolves.toMatchObject({
      status: "current",
      turns: [{ text: firstTurn.text, turnId: firstTurn.turnId }],
    });
    await expect(query.searchHotTail({
      maximumCandidates: 8,
      meetingId,
      neighborTurns: 1,
      question: "cedar launch",
      requesterActorId: "speaker-a",
      roomId: "room-live-2",
      scopeId: "scope-live-1",
    })).resolves.toEqual({ schemaVersion: 1, status: "ineligible" });

    const secondTurn = {
      endMs: 8_000,
      speakerId: "speaker-a",
      startMs: 7_000,
      text: "Actually the cedar launch moved to Monday.",
      turnId: "live-memory-turn-4",
    };
    await repository.appendFinalizedTurn(meetingId, secondTurn);
    await expect(query.searchHotTail({
      maximumCandidates: 8,
      meetingId,
      neighborTurns: 0,
      question: "cedar launch",
      requesterActorId: "speaker-a",
      roomId: "room-live-1",
      scopeId: "scope-live-1",
    })).resolves.toEqual({ schemaVersion: 1, status: "pending" });
    await worker.executeOnce({ meetingId });
    const fresh = await query.searchHotTail({
      maximumCandidates: 8,
      meetingId,
      neighborTurns: 0,
      question: "cedar launch Monday",
      requesterActorId: "speaker-a",
      roomId: "room-live-1",
      scopeId: "scope-live-1",
    });
    expect(fresh).toMatchObject({
      context: { appliedGeneration: 4, sourceGeneration: 4 },
      status: "current",
    });

    const sealedIdentity = {
      ...identity,
      identityProvenance: {
        ...identity.identityProvenance,
        rosterState: "sealed" as const,
      },
    };
    await expect(lifecycle.sealMeeting(sealedIdentity)).resolves.toBe("accepted");
    await expect(lifecycle.removeHuman({
      actorId: "speaker-a",
      meetingId,
      producerRevision: "producer-r1",
    })).resolves.toBe("accepted");
    await expect(query.resolveContext({
      meetingId,
      requesterActorId: "speaker-a",
      roomId: "room-live-1",
    })).resolves.toBeNull();
    await expect(lifecycle.sealMeeting(sealedIdentity)).resolves.toBe("replayed");
    await expect(query.resolveContext({
      meetingId,
      requesterActorId: "speaker-a",
      roomId: "room-live-1",
    })).resolves.toBeNull();
    await lifecycle.finishMeeting(meetingId);
    await expect(lifecycle.registerMeeting(identity)).resolves.toBe("ineligible");

  });
});
