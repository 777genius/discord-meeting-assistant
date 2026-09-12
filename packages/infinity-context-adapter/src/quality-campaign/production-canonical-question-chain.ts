import { createHash } from "node:crypto";

import {
  createFocusedRetrievalGroundingPlan,
  PrepareFocusedLocatorRetrievalV2Request, PrepareFocusedLocatorRetrievalV3Request,
  type FocusedLocatorRetrievalRequestSnapshot,
  type GroundedAnswerGenerationBinding,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  assertConstructedPostgresDiagnosticFinalEvidence,
  type PostgresDiagnosticFinalEvidence,
  assertConstructedPostgresHistoricalEvidenceAuthority,
  assertConstructedPostgresHistoricalMemoryStore,
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
import { InfinityContextRetrievalV3Adapter } from "../infinity-context-retrieval-v3.js";
import { InfinityContextRetrievalV2Adapter } from "../infinity-context-retrieval-v2.js";
import { DiagnosticFrozenStore, assertDiagnosticFrozenStore } from "./diagnostic-frozen-store.js";
import type { DiagnosticQuestion } from "./diagnostic-manifest.js";
import type { CanonicalRetrievalBindingV1 } from
  "./canonical-execution-artifact-validation.js";
import type {
  QualificationCanonicalTurn,
  QualificationQuestionExecutionContext,
  QualificationExternalEffectReservationPort,
  QualificationQuestionOutcome,
  QualificationQuestionAnswerPort,
  QualificationQuestionEvidencePort,
  QualificationQuestionOutcomePort,
  QualificationQuestionRetrievalPort,
} from "./execute-admitted-qualification-question.js";
import type { QualificationScopeTopology, QualificationScopeTopologyPort } from
  "./production-ports.js";
import { createCanonicalEvidencePort } from "./production-canonical-evidence-port.js";
import { createCanonicalRetrievalPort } from "./production-canonical-retrieval-port.js";

export { createProductionCanonicalExecutionEvidence } from
  "./production-canonical-execution-evidence.js";
export { loadProductionExecutionCorpus } from
  "./production-execution-corpus-custody.js";
export type { QualificationScopeTopology, QualificationScopeTopologyPort } from
  "./production-ports.js";

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
      "retrieval_binding" | "retrieval_observation" | "scope_resolution_observation" | "selected_canonical_turns";
    readonly plaintext: Uint8Array }): Promise<void>;
}

export interface ProductionCanonicalQuestionChainInput {
  readonly answer: SubscriptionRuntimeGroundedAnswerAdapter;
  readonly audit: QualificationEncryptedAuditPort;
  readonly evidenceAuthority: PostgresHistoricalEvidenceAuthority;
  readonly ids: HmacHistoricalOpaqueIds;
  readonly journal: QualificationCreateOnlyJournalPort;
  readonly preparer: PrepareFocusedLocatorRetrievalV2Request | PrepareFocusedLocatorRetrievalV3Request;
  readonly retrieval: InfinityContextRetrievalV2Adapter | InfinityContextRetrievalV3Adapter;
  readonly spend: QualificationExternalEffectReservationPort;
  readonly store: PostgresHistoricalMemoryStore;
  readonly topology: QualificationScopeTopologyPort;
}

export interface CanonicalQuestionExecution {
  readonly binding: GroundedAnswerGenerationBinding | null;
  readonly request: FocusedLocatorRetrievalRequestSnapshot;
  readonly retrievalBinding: CanonicalRetrievalBindingV1 | null;
  readonly candidateLocators: readonly string[];
  readonly packet: DiagnosticQuestion;
  readonly topology: QualificationScopeTopology;
  readonly turns: readonly QualificationCanonicalTurn[];
}

export type CanonicalQuestionState = Map<string, CanonicalQuestionExecution>;

export function createProductionCanonicalQuestionChain(
  input: ProductionCanonicalQuestionChainInput,
): { readonly answer: QualificationQuestionAnswerPort;
  readonly evidence: QualificationQuestionEvidencePort;
  readonly outcome: QualificationQuestionOutcomePort;
  readonly retrieval: QualificationQuestionRetrievalPort } {
  if (!isConcreteRetrievalPair(input) ||
    !(input.answer instanceof SubscriptionRuntimeGroundedAnswerAdapter)) {
    throw new Error("canonical qualification chain requires the production adapters");
  }
  assertConstructedPostgresHistoricalEvidenceAuthority(input.evidenceAuthority);
  assertConstructedPostgresHistoricalMemoryStore(input.store);
  assertConstructedHmacHistoricalOpaqueIds(input.ids);
  assertGrpcQualifiedGroundedAnswerAdapter(input.answer);
  return createCanonicalQuestionEngine(input);
}

export interface CanonicalEngineInput extends Omit<ProductionCanonicalQuestionChainInput,
  "store" | "evidenceAuthority"> {
  readonly diagnostic?: true;
  readonly store: Pick<PostgresHistoricalMemoryStore, "findCurrentCandidates" | "isCurrentGeneration">;
  readonly evidenceAuthority: Pick<PostgresHistoricalEvidenceAuthority, "loadAcceptedFinalMeeting">;
}

/** Diagnostic construction cannot issue production PostgreSQL authority. */
export function createDiagnosticCanonicalQuestionChain(input: Omit<ProductionCanonicalQuestionChainInput,
  "store" | "evidenceAuthority"> & {
    readonly store: DiagnosticFrozenStore;
    readonly evidenceAuthority: PostgresDiagnosticFinalEvidence;
  }) {
  assertConstructedPostgresDiagnosticFinalEvidence(input.evidenceAuthority);
  assertDiagnosticFrozenStore(input.store);
  if (input.store.authority !== input.evidenceAuthority ||
    !isConcreteRetrievalPair(input)) {
    throw new Error("diagnostic chain requires concrete bound adapters");
  }
  assertConstructedHmacHistoricalOpaqueIds(input.ids);
  assertGrpcQualifiedGroundedAnswerAdapter(input.answer);
  return createCanonicalQuestionEngine({...input, diagnostic:true});
}

function isConcreteRetrievalPair(input: Pick<ProductionCanonicalQuestionChainInput, "preparer" | "retrieval">): boolean {
  return (input.preparer instanceof PrepareFocusedLocatorRetrievalV2Request &&
    input.retrieval instanceof InfinityContextRetrievalV2Adapter) ||
    (input.preparer instanceof PrepareFocusedLocatorRetrievalV3Request &&
    input.retrieval instanceof InfinityContextRetrievalV3Adapter);
}

function createCanonicalQuestionEngine(input: CanonicalEngineInput) {
  const state: CanonicalQuestionState = new Map();
  const retrieval = createCanonicalRetrievalPort(input, state);
  const evidence = createCanonicalEvidencePort(input, state);
  const answer = createAnswerPort(input, state);
  const outcome: QualificationQuestionOutcomePort = Object.freeze({
    record: async (attemptId: string, value: QualificationQuestionOutcome) => {
      await input.audit.seal({ attemptId, kind: "answer_normalized_outcome",
        plaintext: utf8Json(value) });
      state.delete(attemptId);
    },
  });
  return Object.freeze({ answer, evidence, outcome, retrieval });
}

function createAnswerPort(input: CanonicalEngineInput,
  state: CanonicalQuestionState): QualificationQuestionAnswerPort {
  return Object.freeze({ generate: async (
    request: Parameters<QualificationQuestionAnswerPort["generate"]>[0],
    options: QualificationQuestionExecutionContext,
  ) => {
    const execution = state.get(options.attemptId);
    if (execution === undefined || execution.binding === null ||
      execution.packet.questionId !== request.questionId ||
      execution.packet.questionText !== request.questionText || execution.packet.locale !== request.locale ||
      execution.binding.memoryGeneration !== request.authorityGeneration ||
      execution.binding.canonicalEvidenceHash !== request.canonicalEvidenceHash ||
      execution.binding.transcriptVersion !== request.transcriptVersion ||
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
    const payloadSha256 = sha256Json({ effectKind: "answer", request: prepared.request });
    await input.spend.reserve({ effectKind: "answer", payloadSha256,
      requestedEncryptedBytes: 16_000, requestedTokens: 2_048 });
    await input.journal.reserve({ attemptId, payloadSha256, phase: "answer" });
    const generated = await input.answer.generate(groundedRequest, options);
    const observation = input.answer.takeQualificationObservation(attemptId);
    await sealAnswerExchanges(input.audit, attemptId, observation.exchanges.original,
      observation.exchanges.repair, prepared.modelInputs);
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
  } });
}

async function sealAnswerExchanges(audit: QualificationEncryptedAuditPort, attemptId: string,
  original: KnowledgeAnswerProviderExchange | null, repair: KnowledgeAnswerProviderExchange | null,
  modelInputs: { readonly original: string; readonly repair: string }) {
  if (original === null) {
    if (repair !== null) {throw new Error("repair answer exchange lacks its original exchange");}
    return;
  }
  await audit.seal({ attemptId, kind: "answer_original_model_surface",
    plaintext: utf8(modelInputs.original) });
  await audit.seal({ attemptId, kind: "answer_original_request", plaintext: original.requestBytes });
  await audit.seal({ attemptId, kind: "answer_original_response", plaintext: original.responseBytes });
  if (repair !== null) {
    await audit.seal({ attemptId, kind: "answer_repair_model_surface",
      plaintext: utf8(modelInputs.repair) });
    await audit.seal({ attemptId, kind: "answer_repair_request", plaintext: repair.requestBytes });
    await audit.seal({ attemptId, kind: "answer_repair_response", plaintext: repair.responseBytes });
  }
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function utf8(value: string): Uint8Array {return new TextEncoder().encode(value);}
function utf8Json(value: unknown): Uint8Array {return utf8(JSON.stringify(value));}
