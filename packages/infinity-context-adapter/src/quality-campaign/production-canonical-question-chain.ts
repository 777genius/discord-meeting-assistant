import { createHash } from "node:crypto";

import {
  createFocusedRetrievalGroundingPlan,
  PrepareFocusedLocatorRetrievalV2Request,
  rehydrateHistoricalBlock,
  type FocusedLocatorRetrievalV2RequestSnapshot,
  type GroundedAnswerGenerationBinding,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  assertConstructedPostgresHistoricalEvidenceAuthority,
  assertConstructedPostgresHistoricalMemoryStore,
  canonicalFinalReplyTurnHash,
  PostgresHistoricalEvidenceAuthority,
  PostgresHistoricalMemoryStore,
} from "@discord-meeting/postgres-adapter";
import {
  assertGrpcQualifiedGroundedAnswerAdapter,
  SubscriptionRuntimeGroundedAnswerAdapter,
  type KnowledgeAnswerProviderExchange,
} from "@discord-meeting/subscription-runtime-adapter";

import { assertConstructedHmacHistoricalOpaqueIds,
  type HmacHistoricalOpaqueIds } from "../hmac-historical-ids.js";
import { InfinityContextRetrievalV2Adapter } from "../infinity-context-retrieval-v2.js";
import type {
  QualificationCanonicalTurn,
  QualificationQuestionExecutionContext,
  QualificationExternalEffectReservationPort,
  QualificationQuestionOutcome,
  QualificationExecutionPacket,
  QualificationQuestionAnswerPort,
  QualificationQuestionEvidencePort,
  QualificationQuestionOutcomePort,
  QualificationQuestionRetrievalPort,
} from "./execute-admitted-qualification-question.js";

export { createProductionCanonicalExecutionEvidence } from
  "./production-canonical-execution-evidence.js";
export { loadProductionExecutionCorpus } from
  "./production-execution-corpus-custody.js";

export interface QualificationCreateOnlyJournalPort {
  reserve(input: { readonly attemptId: string; readonly payloadSha256: string;
    readonly phase: "answer" | "retrieval" }): Promise<void>;
  terminal(input: { readonly attemptId: string; readonly payloadSha256: string;
    readonly phase: "answer" | "retrieval";
    readonly state: "failed" | "outcome_unknown" | "succeeded" }): Promise<void>;
}

export interface QualificationEncryptedAuditPort {
  seal(input: { readonly attemptId: string;
    readonly kind: "answer_normalized_outcome" | "answer_original_model_surface" |
      "answer_original_request" | "answer_original_response" | "answer_repair_model_surface" |
      "answer_repair_request" | "answer_repair_response" | "capability_request" |
      "capability_response" | "retrieval_request" | "retrieval_response" |
      "selected_canonical_turns";
    readonly plaintext: Uint8Array }): Promise<void>;
}

export interface QualificationScopeTopology {
  readonly currentMeetingId: string;
  readonly roomId: string;
  readonly scopeId: string;
}

/** Resolves only an already authenticated execution-safe reference. */
export interface QualificationScopeTopologyPort {
  resolve(reference: string, questionId: string): Promise<QualificationScopeTopology>;
}

export function createProductionCanonicalQuestionChain(input: {
  readonly answer: SubscriptionRuntimeGroundedAnswerAdapter;
  readonly audit: QualificationEncryptedAuditPort;
  readonly evidenceAuthority: PostgresHistoricalEvidenceAuthority;
  readonly ids: HmacHistoricalOpaqueIds;
  readonly journal: QualificationCreateOnlyJournalPort;
  readonly preparer: PrepareFocusedLocatorRetrievalV2Request;
  readonly retrieval: InfinityContextRetrievalV2Adapter;
  readonly spend: QualificationExternalEffectReservationPort;
  readonly store: PostgresHistoricalMemoryStore;
  readonly topology: QualificationScopeTopologyPort;
}): { readonly answer: QualificationQuestionAnswerPort;
  readonly evidence: QualificationQuestionEvidencePort;
  readonly outcome: QualificationQuestionOutcomePort;
  readonly retrieval: QualificationQuestionRetrievalPort } {
  if (!(input.preparer instanceof PrepareFocusedLocatorRetrievalV2Request) ||
    !(input.retrieval instanceof InfinityContextRetrievalV2Adapter) ||
    !(input.answer instanceof SubscriptionRuntimeGroundedAnswerAdapter)) {
    throw new Error("canonical qualification chain requires the production adapters");
  }
  assertConstructedPostgresHistoricalEvidenceAuthority(input.evidenceAuthority);
  assertConstructedPostgresHistoricalMemoryStore(input.store);
  assertConstructedHmacHistoricalOpaqueIds(input.ids);
  assertGrpcQualifiedGroundedAnswerAdapter(input.answer);
  const state = new Map<string, { readonly binding: GroundedAnswerGenerationBinding | null;
    readonly packet: QualificationExecutionPacket;
    readonly topology: QualificationScopeTopology;
    readonly turns: readonly QualificationCanonicalTurn[] }>();

  const retrieval: QualificationQuestionRetrievalPort = Object.freeze({
    retrieve: async (packet: QualificationExecutionPacket,
      options: QualificationQuestionExecutionContext) => {
      const topology = await input.topology.resolve(packet.scopeTopologyReference,
        packet.questionId);
      const prepared = await input.preparer.prepare({ ...topology, question: packet.questionText,
        signal: options.signal });
      if (prepared.status !== "prepared") {
        return { reason: `request_${prepared.status}`, status: "failed" as const };
      }
      assertCanonicalRequest(prepared, packet.questionText);
      const attemptId = options.attemptId;
      const payloadSha256 = sha256Json({ effectKind: "retrieval", request: prepared });
      await input.spend.reserve({ effectKind: "capability",
        payloadSha256: sha256Json({ effectKind: "capability", request: prepared }),
        requestedEncryptedBytes: 16_000, requestedTokens: 1 });
      await input.spend.reserve({ effectKind: "retrieval", payloadSha256,
        requestedEncryptedBytes: 16_000, requestedTokens: 1 });
      await input.journal.reserve({ attemptId, payloadSha256, phase: "retrieval" });
      let result;
      try {result = await input.retrieval.retrieve(prepared, options);}
      catch (error) {
        await input.journal.terminal({ attemptId, payloadSha256: sha256Json({
          reason: "retrieval_external_effect_unknown" }), phase: "retrieval",
          state: "outcome_unknown" });
        throw error;
      }
      let exchange;
      try {exchange = input.retrieval.takeExactExchange();}
      catch (error) {
        await input.journal.terminal({ attemptId, payloadSha256: sha256Json({
          reason: "retrieval_external_effect_unknown" }), phase: "retrieval",
        state: "outcome_unknown" });
        throw new Error("retrieval external effect is unknown and terminal", { cause: error });
      }
      await Promise.all([
        input.audit.seal({ attemptId, kind: "capability_request",
          plaintext: exchange.capabilityRequestBytes }),
        input.audit.seal({ attemptId, kind: "capability_response",
          plaintext: exchange.capabilityResponseBytes }),
        input.audit.seal({ attemptId, kind: "retrieval_request",
          plaintext: exchange.requestBytes }),
        input.audit.seal({ attemptId, kind: "retrieval_response",
          plaintext: exchange.responseBytes }),
      ]);
      await input.journal.terminal({ attemptId, payloadSha256: sha256Json({ result,
        responseSha256: createHash("sha256").update(exchange.responseBytes).digest("hex") }),
        phase: "retrieval",
        state: result.status === "available" ? "succeeded" : "failed" });
      if (result.status !== "available") {
        return { reason: result.code, status: "failed" as const };
      }
      state.set(options.attemptId, { binding: null, packet, topology, turns: [] });
      return Object.freeze({ candidates: Object.freeze(result.candidates.map((candidate) =>
        Object.freeze({ contributions: Object.freeze(candidate.retrievalProvenance.contributions
          .map((contribution) => Object.freeze({ ...contribution }))),
        fusedScore: candidate.retrievalProvenance.fusedScore,
        locatorId: candidate.locator,
        providerRank: candidate.retrievalProvenance.providerRank }))),
      rawResponseSha256: createHash("sha256").update(exchange.responseBytes).digest("hex"),
      status: "completed" as const });
    },
  });

  const evidence: QualificationQuestionEvidencePort = Object.freeze({
    rehydrate: async (request: Parameters<QualificationQuestionEvidencePort["rehydrate"]>[0],
      options: QualificationQuestionExecutionContext) => {
      const execution = state.get(options.attemptId);
      if (execution === undefined || execution.packet.scopeTopologyReference !==
        request.scopeTopologyReference || new Set(request.locatorIds).size !==
          request.locatorIds.length) {
        throw new Error("canonical qualification retrieval state is absent or duplicated");
      }
      const records = await input.store.findCurrentCandidates(execution.topology.scopeId,
        execution.topology.roomId, request.locatorIds, { signal: options.signal });
      if (records.length !== request.locatorIds.length) {
        throw new Error("PostgreSQL locator authority is missing or ambiguous");
      }
      const turns: QualificationCanonicalTurn[] = [];
      let binding: GroundedAnswerGenerationBinding | null = null;
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        if (!await input.store.isCurrentGeneration(record.binding,
          record.plan.topology.indexGeneration, { signal: options.signal }) ||
          record.binding.scopeId !== execution.topology.scopeId ||
          record.binding.roomId !== execution.topology.roomId) {
          throw new Error("PostgreSQL locator is stale or cross-room");
        }
        const meeting = await input.evidenceAuthority.loadAcceptedFinalMeeting(record.binding,
          { signal: options.signal });
        if (meeting === null) {
          throw new Error("PostgreSQL locator does not reference an accepted final meeting");
        }
        const block = rehydrateHistoricalBlock(meeting, record.plan, record.ordinal, input.ids);
        if (block.candidateLocator !== request.locatorIds[index]) {
          throw new Error("PostgreSQL locator order or ownership is ambiguous");
        }
        turns.push(...block.turns.map((turn) => Object.freeze({ endMs: turn.endMs,
          sourceLocatorId: block.candidateLocator, speakerId: turn.speakerId,
          startMs: turn.startMs, text: turn.text, turnHash: canonicalFinalReplyTurnHash(turn),
          turnId: turn.turnId })));
        const nextBinding = Object.freeze({ canonicalEvidenceHash: sha256Json(
          turns.map(({ turnHash }) => turnHash)), memoryGeneration: block.indexGeneration,
        transcriptVersion: block.binding.transcriptVersion });
        if (binding !== null && binding.memoryGeneration !== nextBinding.memoryGeneration) {
          throw new Error("PostgreSQL selected locators span ambiguous generations");
        }
        binding = nextBinding;
      }
      const resolved = binding ?? Object.freeze({ canonicalEvidenceHash: sha256Json([]),
        memoryGeneration: "qualification-empty:v1", transcriptVersion: 0 });
      state.set(options.attemptId, { ...execution, binding: resolved,
        turns: Object.freeze(turns) });
      await input.audit.seal({ attemptId: options.attemptId,
        kind: "selected_canonical_turns", plaintext: utf8Json(turns) });
      return Object.freeze({ authorityGeneration: resolved.memoryGeneration,
        canonicalEvidenceHash: resolved.canonicalEvidenceHash,
        transcriptVersion: resolved.transcriptVersion, turns: Object.freeze(turns) });
    },
  });

  const answer: QualificationQuestionAnswerPort = Object.freeze({
    generate: async (request: Parameters<QualificationQuestionAnswerPort["generate"]>[0],
      options: QualificationQuestionExecutionContext) => {
      const execution = state.get(options.attemptId);
      if (execution === undefined || execution.binding === null ||
        JSON.stringify(execution.turns) !== JSON.stringify(request.evidence)) {
        throw new Error("grounded answer evidence is not the selected PostgreSQL evidence");
      }
      const plan = createFocusedRetrievalGroundingPlan({ authorityGeneration:
        request.authorityGeneration, coverage: "sufficient",
      humanActorIds: [...new Set(request.evidence.map(({ speakerId }) => speakerId))],
      turns: request.evidence });
      const attemptId = options.attemptId;
      const groundedRequest = { attemptId, binding: execution.binding,
        locale: request.locale, plan, question: request.questionText };
      const prepared = input.answer.prepare(groundedRequest);
      await Promise.all([
        input.audit.seal({ attemptId, kind: "answer_original_model_surface",
          plaintext: utf8(prepared.modelInputs.original) }),
        input.audit.seal({ attemptId, kind: "answer_repair_model_surface",
          plaintext: utf8(prepared.modelInputs.repair) }),
      ]);
      const payloadSha256 = sha256Json({ effectKind: "answer", request: prepared.request });
      await input.spend.reserve({ effectKind: "answer", payloadSha256,
        requestedEncryptedBytes: 16_000, requestedTokens: 2_048 });
      await input.journal.reserve({ attemptId, payloadSha256, phase: "answer" });
      const generated = await input.answer.generate(groundedRequest, options);
      const observation = input.answer.takeQualificationObservation(attemptId);
      await sealAnswerExchanges(input.audit, attemptId, observation.exchanges.original,
        observation.exchanges.repair);
      const stateValue = observation.providerBytesSent && !observation.outcomeCertain ?
        "outcome_unknown" as const : generated.status === "completed" ?
          "succeeded" as const : "failed" as const;
      await input.journal.terminal({ attemptId, payloadSha256: sha256Json({ generated,
        outcomeCertain: observation.outcomeCertain,
        runtimeReceiptSha256: observation.runtimeReceiptSha256 }), phase: "answer",
        state: stateValue });
      state.delete(options.attemptId);
      if (stateValue === "outcome_unknown") {
        throw new Error("grounded answer external effect is unknown and terminal");
      }
      if (generated.status !== "completed") {
        return { reason: generated.code, status: "failed" as const };
      }
      if (generated.answer.status !== "answered") {
        return { citations: [], claims: [], status: "abstained" as const };
      }
      const byEvidenceId = new Map(plan.evidence.map((turn) => [turn.evidenceId, turn.turnId]));
      return Object.freeze({ citations: Object.freeze([...new Set(generated.answer.claims
        .flatMap(({ evidenceIds }) => evidenceIds.map((id) => byEvidenceId.get(id))
          .filter((id): id is string => id !== undefined)))]),
      claims: Object.freeze(generated.answer.claims.map(({ text }) => text)),
      status: "answered" as const });
    },
  });
  const outcome: QualificationQuestionOutcomePort = Object.freeze({
    record: async (attemptId: string, value: QualificationQuestionOutcome) => {
      await input.audit.seal({ attemptId, kind: "answer_normalized_outcome",
        plaintext: utf8Json(value) });
      state.delete(attemptId);
    },
  });
  return Object.freeze({ answer, evidence, outcome, retrieval });
}

function assertCanonicalRequest(request: FocusedLocatorRetrievalV2RequestSnapshot,
  question: string): void {
  if (request.budgets.candidateLimit !== 100 || request.budgets.resultLimit !== 10 ||
    request.budgets.neighborRadius !== 0 || request.queries.length !== 1 ||
    request.queries[0]?.queryId !== "original-question" ||
    request.queries[0]?.query.length === 0 || question.trim().length === 0) {
    throw new Error("qualification request violates Meeting Knowledge ownership");
  }
}

async function sealAnswerExchanges(audit: QualificationEncryptedAuditPort, attemptId: string,
  original: KnowledgeAnswerProviderExchange, repair: KnowledgeAnswerProviderExchange | null) {
  await audit.seal({ attemptId, kind: "answer_original_request", plaintext: original.requestBytes });
  await audit.seal({ attemptId, kind: "answer_original_response", plaintext: original.responseBytes });
  if (repair !== null) {
    await audit.seal({ attemptId, kind: "answer_repair_request", plaintext: repair.requestBytes });
    await audit.seal({ attemptId, kind: "answer_repair_response", plaintext: repair.responseBytes });
  }
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function utf8(value: string): Uint8Array {return new TextEncoder().encode(value);}
function utf8Json(value: unknown): Uint8Array {return utf8(JSON.stringify(value));}
