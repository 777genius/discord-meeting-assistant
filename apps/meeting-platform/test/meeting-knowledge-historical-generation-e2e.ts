import {
  ProcessFinalReplyJob,
  type FocusedMemoryRetrievalPort,
  type GroundingPlan,
  type QuestionBindingSnapshot,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { DurableAnswerPublication } from
  "@discord-meeting/meeting-core/publishing";
import {
  DiscordAnswerPayloadCodec,
  DiscordGroundedAnswerRenderer,
} from "@discord-meeting/discord-adapter";
import {
  PostgresAnswerEffectStore,
  PostgresFinalReplyEvidence,
  PostgresQuestionAdmissionCommit,
  PostgresQuestionJobStore,
} from "@discord-meeting/postgres-adapter";
import type { Pool } from "pg";
import { expect } from "vitest";

import {
  localFinalReplyPolicy,
  localFinalReplyPolicyRelease,
} from "../src/composition/meeting-knowledge.js";
import {
  botApplicationIdentity,
} from "./meeting-knowledge-production-composition-fixtures.js";

const readyQuestionId = "666666666666666666";

interface AppliedGenerationRow {
  readonly applied_index_profile_id: string;
  readonly index_generation: string;
}

async function appliedGeneration(
  pool: Pool,
  meetingId: string,
): Promise<AppliedGenerationRow> {
  const result = await pool.query<AppliedGenerationRow>(
    `SELECT applied_index_profile_id,
            plan -> 'topology' ->> 'indexGeneration' AS index_generation
     FROM meeting_core.historical_memory_sync
     WHERE meeting_id = $1 AND is_current AND state = 'applied'`,
    [meetingId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("historical rebuild fixture has no applied generation");
  }
  return row;
}

export interface HistoricalReadyPublicationFenceHooks {
  beforeSupersession(): Promise<void>;
  afterSupersession(): Promise<void>;
}

export function prepareHistoricalReadyPublicationFence(input: {
  readonly binding: QuestionBindingSnapshot;
  readonly evidence: PostgresFinalReplyEvidence;
  readonly historicalMeetingId: string;
  readonly plan: GroundingPlan;
  readonly pool: Pool;
}): HistoricalReadyPublicationFenceHooks {
  const authorization = {
    actorId: input.binding.humanActorIds[0] ?? "human-current",
    containerId: input.binding.projectionTargetContainerId,
    deliveryContainerId: input.binding.deliveryContainerId,
    digest: input.binding.authorizationDigest,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    observedAt: new Date().toISOString(),
    policyVersion: input.binding.authorizationPolicyVersion,
    scopeId: input.binding.scopeId,
    source: "authoritative_remote" as const,
    status: "authorized" as const,
  };
  let generationOne: AppliedGenerationRow | undefined;
  return {
    beforeSupersession: async () => {
      const jobs = new PostgresQuestionJobStore(
        input.pool,
        localFinalReplyPolicyRelease,
      );
      const admission = new PostgresQuestionAdmissionCommit(
        input.pool,
        botApplicationIdentity,
        localFinalReplyPolicyRelease,
      );
      await expect(admission.commit({
        authorization,
        binding: input.binding,
        questionText: "What connects CURRENT-ANCHOR and PINE-GOLF?",
        ratePolicy: localFinalReplyPolicy.admission,
      })).resolves.toEqual({ jobId: readyQuestionId, status: "committed" });
      const lease = await jobs.leaseNext({
        leaseSeconds: 60,
        maximumProviderAttempts: localFinalReplyPolicy.maximumProviderAttempts,
        workerId: "historical-generation-g1",
      });
      if (lease === null) {
        throw new Error("historical generation fixture did not lease its question");
      }
      expect(await jobs.persistGroundingPlan({
        generation: lease.generation,
        jobId: lease.jobId,
        measurement: { inputTokens: 1_000, requestBytes: 4_000 },
        plan: input.plan,
        runtimeProfile: "synthetic-ready-restart.v1",
        sourceMeetingIds: [...new Set(input.plan.evidence.map(
          ({ source }) => source?.meetingId ?? input.binding.meetingId,
        ))],
      })).toBe(true);
      const attemptId = `${lease.jobId}:generation:${lease.generation}:attempt:1`;
      expect(await jobs.reserveProviderAttempt({
        attemptId,
        generation: lease.generation,
        jobId: lease.jobId,
        leaseSeconds: 60,
        maximumProviderAttempts: localFinalReplyPolicy.maximumProviderAttempts,
      })).toBe(true);
      expect(await jobs.completeProviderAttempt({
        answerCandidate: {
          claims: [{
            evidenceIds: [input.plan.evidence[0]?.evidenceId ?? ""],
            text: "The current and historical evidence are connected.",
          }],
          locale: "en",
          status: "answered",
        },
        attemptId,
        generation: lease.generation,
        jobId: lease.jobId,
      })).toBe(true);
      const ready = await input.pool.query<{
        readonly has_grounding_plan: boolean;
        readonly state: string;
      }>(
        `SELECT grounding_plan IS NOT NULL AS has_grounding_plan, state
         FROM meeting_knowledge.question_jobs WHERE question_id = $1`,
        [readyQuestionId],
      );
      expect(ready.rows[0]).toEqual({ has_grounding_plan: true, state: "ready" });
      generationOne = await appliedGeneration(
        input.pool,
        input.historicalMeetingId,
      );
    },
    afterSupersession: async () => {
    if (generationOne === undefined) {
      throw new Error("historical generation G1 fence was not prepared");
    }
    const generationTwo = await appliedGeneration(
      input.pool,
      input.historicalMeetingId,
    );
    expect(generationTwo.index_generation).not.toBe(
      generationOne.index_generation,
    );
    expect(generationTwo.applied_index_profile_id).toBe(
      generationOne.applied_index_profile_id,
    );
    await expect(input.evidence.rehydrateSelectedEvidence(
      input.binding,
      input.plan.evidence.map(({ source, turnHash, turnId }) => ({
        ...(source?.historicalSource === undefined
          ? {}
          : { historicalSource: source.historicalSource }),
        meetingId: source?.meetingId ?? input.binding.meetingId,
        ...(source?.sourceEndCodePoint === undefined
          ? {}
          : {
              sourceEndCodePoint: source.sourceEndCodePoint,
              sourceStartCodePoint: source.sourceStartCodePoint,
            }),
        transcriptId: source?.transcriptId ?? input.binding.transcriptId,
        transcriptVersion: source?.transcriptVersion ??
          input.binding.transcriptVersion,
        turnHash,
        turnId,
      })),
    )).resolves.toEqual({ status: "invalid_selection" });

    await input.pool.query(
      `UPDATE meeting_knowledge.question_jobs
       SET lease_until = transaction_timestamp() - interval '1 second'
       WHERE question_id = $1`,
      [readyQuestionId],
    );

    let deliveryCreates = 0;
    let generatorCalls = 0;
    const publication = new DurableAnswerPublication({
      delivery: {
        create: async () => {
          deliveryCreates += 1;
          return "synthetic-delivery-receipt";
        },
        inspect: async () => ({ status: "unconfirmed" as const }),
        remove: async () => {},
      },
      payloads: new DiscordAnswerPayloadCodec(),
      store: new PostgresAnswerEffectStore(
        input.pool,
        localFinalReplyPolicyRelease,
      ),
    });
    const memory: FocusedMemoryRetrievalPort = {
      reauthorizeHistoricalEvidence: async () => true,
      retrieve: async () => {
        throw new Error("ready job must not repeat retrieval");
      },
    };
    const processor = new ProcessFinalReplyJob({
      answerPublication: publication,
      authorization: {
        observe: async ({ checkpoint }) => ({
          actorId: authorization.actorId,
          checkpoint,
          containerId: authorization.containerId,
          deliveryContainerId: authorization.deliveryContainerId,
          digest: authorization.digest,
          expiresAt: authorization.expiresAt,
          observedAt: new Date().toISOString(),
          policyVersion: authorization.policyVersion,
          scopeId: authorization.scopeId,
          source: authorization.source,
          status: authorization.status,
        }),
      },
      evidence: new PostgresFinalReplyEvidence(
        input.pool,
        botApplicationIdentity,
      ),
      generator: {
        generate: async () => {
          generatorCalls += 1;
          throw new Error("ready job must not regenerate an answer");
        },
        measure: async () => {
          generatorCalls += 1;
          throw new Error("ready job must not remeasure an answer");
        },
      },
      jobs: new PostgresQuestionJobStore(
        input.pool,
        localFinalReplyPolicyRelease,
      ),
      memory,
      policy: localFinalReplyPolicy,
      renderer: new DiscordGroundedAnswerRenderer(),
      selector: {
        execute: async () => {
          throw new Error("ready job must not repeat evidence selection");
        },
      },
      workerId: "historical-generation-g2-restart",
    });
    await expect(processor.executeOnce()).resolves.toMatchObject({
      jobId: readyQuestionId,
      outcome: "stale_binding",
      status: "settled",
    });
    expect({ deliveryCreates, generatorCalls }).toEqual({
      deliveryCreates: 0,
      generatorCalls: 0,
    });
    const effects = await input.pool.query(
      "SELECT 1 FROM meeting_core.answer_effects WHERE effect_id = $1",
      [`meeting-knowledge-answer:v1:${readyQuestionId}`],
    );
    expect(effects.rowCount).toBe(0);
    },
  };
}
