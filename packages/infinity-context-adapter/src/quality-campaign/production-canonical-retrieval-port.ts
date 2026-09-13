import { createHash } from "node:crypto";

import { InfinityContextRetrievalV2Adapter } from "../infinity-context-retrieval-v2.js";
import { InfinityContextRetrievalV3Adapter } from "../infinity-context-retrieval-v3.js";
import type { InfinityContextRetrievalV2ExactExchange, InfinityContextRetrievalV3ExactExchange } from
  "../infinity-context-retrieval-exchange.js";
import { canonicalJson } from "./canonical.js";
import { assertCanonicalRequest, createCanonicalRetrievalBinding, custodyDigest, custodyJson,
  freezeCustody, validateCanonicalRetrievalObservation,
  validateCanonicalScopeResolutionObservation, type CanonicalRetrievalBindingV1 } from
  "./canonical-execution-artifact-validation.js";
import { DiagnosticFrozenStore } from "./diagnostic-frozen-store.js";
import type { DiagnosticQuestion } from "./diagnostic-manifest.js";
import type { QualificationExecutionPacket, QualificationQuestionExecutionContext } from
  "./execute-admitted-qualification-question.js";
import type { CanonicalEngineInput, CanonicalQuestionState,
  ProductionCanonicalQuestionChainInput, QualificationEncryptedAuditPort } from
  "./production-canonical-question-chain.js";

type PreparedRequest = Awaited<ReturnType<ProductionCanonicalQuestionChainInput["preparer"]["prepare"]>>;
interface RetrievalExecution {
  readonly attemptId: string;
  readonly packet: DiagnosticQuestion | QualificationExecutionPacket;
  readonly payloadSha256: string;
  readonly prepared: Extract<PreparedRequest, { readonly status: "prepared" }>;
  readonly topology: Awaited<ReturnType<typeof resolveTopology>>;
}

export function createCanonicalRetrievalPort(input: CanonicalEngineInput,
  state: CanonicalQuestionState) {
  return Object.freeze({ retrieve: async (
    rawPacket: DiagnosticQuestion | QualificationExecutionPacket,
    options: QualificationQuestionExecutionContext) => {
    const packet = freezeCustody(structuredClone(rawPacket));
    const topology = await resolveTopology(input, packet);
    const prepared = await prepareAndAudit(input, packet, topology, options);
    if (prepared.status !== "prepared") {
      return { reason: `request_${prepared.status}`, status: "failed" as const };
    }
    assertCanonicalRequest(prepared, packet.questionText);
    return await executeRetrieval(input, state, { attemptId: options.attemptId, packet,
      payloadSha256: sha256Json({ effectKind: "retrieval", request: prepared }),
      prepared, topology }, options);
  } });
}

async function resolveTopology(input: CanonicalEngineInput,
  packet: DiagnosticQuestion | QualificationExecutionPacket) {
  const qualificationPacket = "source" in packet ? packet : null;
  const topologyBinding = qualificationPacket?.schemaVersion ===
    "meeting_knowledge.qualification_execution_packet.v2" ? {
      topologyDocumentSha256: qualificationPacket.scopeTopologyDocumentSha256,
      topologyGeneration: qualificationPacket.scopeTopologyGeneration,
    } : undefined;
  return freezeCustody(structuredClone(await input.topology.resolve(
    packet.scopeTopologyReference, packet.questionId, topologyBinding)));
}

async function prepareAndAudit(input: CanonicalEngineInput,
  packet: DiagnosticQuestion | QualificationExecutionPacket,
  topology: Awaited<ReturnType<typeof resolveTopology>>,
  options: QualificationQuestionExecutionContext): Promise<PreparedRequest> {
  const scopeReads: { readonly kind: string; readonly requestSha256: string;
    readonly responseSha256: string | null; readonly responseBytes: number;
    readonly status: string }[] = [];
  let prepared: PreparedRequest | undefined;
  try {
    prepared = await input.preparer.prepare({ ...topology, question: packet.questionText,
      signal: options.signal, scopeResolutionEffects: {
        beforeRead: async ({ kind, requestSha256 }) => {
          await input.spend.reserve({ effectKind: kind, payloadSha256: requestSha256,
            requestedEncryptedBytes: 2048, requestedTokens: 1 });
          scopeReads.push({ kind, requestSha256, responseSha256: null,
            responseBytes: 0, status: "outcome_unknown" });
        },
        observe: async (observation) => {
          const index = scopeReads.findIndex(({ kind }) => kind === observation.kind);
          if (index < 0 || scopeReads[index]!.requestSha256 !== observation.requestSha256 ||
            scopeReads[index]!.status !== "outcome_unknown") {
            throw new Error("Unreserved or duplicate scope metadata effect");
          }
          scopeReads[index] = observation;
        },
      } });
  } finally {
    const observation = { schemaVersion: "meeting_knowledge.scope_resolution.v1",
      status: prepared?.status ?? "interrupted", reads: scopeReads };
    if (observation.status === "prepared") {validateCanonicalScopeResolutionObservation(observation);}
    await input.audit.seal({ attemptId: options.attemptId, kind: "scope_resolution_observation",
      plaintext: utf8(canonicalJson(observation)) });
  }
  return prepared;
}

async function executeRetrieval(input: CanonicalEngineInput, state: CanonicalQuestionState,
  execution: RetrievalExecution,
  options: QualificationQuestionExecutionContext) {
  await reserveRetrieval(input, execution.prepared, execution.attemptId, execution.payloadSha256);
  const result = await invokeRetrieval(input, execution, options);
  const captured = await captureRetrieval(input, result, execution);
  const retrievalBinding = await validateAndAuditRetrieval(input, execution, result, captured);
  if (retrievalBinding === "invalid") {
    return { reason: result.status === "available" ? "retrieval_observation_evidence_invalid" : result.code,
      status: "failed" as const };
  }
  await input.journal.terminal({ attemptId: execution.attemptId, payloadSha256: sha256Json({ result,
    responseSha256: createHash("sha256").update(captured.exchange.responseBytes).digest("hex") }),
    phase: "retrieval", state: result.status === "available" ? "succeeded" : "failed" });
  if (result.status !== "available") {return { reason: result.code, status: "failed" as const };}
  state.set(execution.attemptId, { binding: null, packet: execution.packet,
    topology: execution.topology, turns: [],
    request: freezeCustody(structuredClone(execution.prepared)), retrievalBinding,
    candidateLocators: Object.freeze(result.candidates.map(candidate => candidate.locator)) });
  return Object.freeze({ candidates: Object.freeze(result.candidates.map((candidate) =>
    Object.freeze({ contributions: Object.freeze(candidate.retrievalProvenance.contributions
      .map((contribution) => Object.freeze({ ...contribution }))),
    fusedScore: candidate.retrievalProvenance.fusedScore, locatorId: candidate.locator,
    providerRank: candidate.retrievalProvenance.providerRank }))),
  rawResponseSha256: createHash("sha256").update(captured.exchange.responseBytes).digest("hex"),
  status: "completed" as const });
}

async function reserveRetrieval(input: CanonicalEngineInput, prepared: PreparedRequest,
  attemptId: string, payloadSha256: string): Promise<void> {
  await input.spend.reserve({ effectKind: "capability",
    payloadSha256: sha256Json({ effectKind: "capability", request: prepared }),
    requestedEncryptedBytes: 16_000, requestedTokens: 1 });
  await input.spend.reserve({ effectKind: "retrieval", payloadSha256,
    requestedEncryptedBytes: 16_000, requestedTokens: 1 });
  await input.journal.reserve({ attemptId, payloadSha256, phase: "retrieval" });
}

async function invokeRetrieval(input: CanonicalEngineInput, execution: RetrievalExecution,
  options: QualificationQuestionExecutionContext) {
  try {
    if (execution.prepared.schemaVersion === 3 &&
      input.retrieval instanceof InfinityContextRetrievalV3Adapter) {
      return await input.retrieval.retrieve(execution.prepared, options);
    }
    if (execution.prepared.schemaVersion === 2 &&
      input.retrieval instanceof InfinityContextRetrievalV2Adapter) {
      return await input.retrieval.retrieve(execution.prepared, options);
    }
    throw new Error("mixed canonical retrieval pair");
  } catch (error) {
    await input.journal.terminal({ attemptId: execution.attemptId, payloadSha256: sha256Json({
      reason: "retrieval_external_effect_unknown" }), phase: "retrieval", state: "outcome_unknown" });
    throw error;
  }
}

async function captureRetrieval(input: CanonicalEngineInput,
  result: Awaited<ReturnType<typeof invokeRetrieval>>, execution: RetrievalExecution) {
  let exchange;
  let observation;
  let exactExchangeError: unknown;
  let observationError: unknown;
  try {exchange = input.retrieval.takeExactExchange();} catch (error) {exactExchangeError = error;}
  try {observation = input.retrieval.takeObservation();} catch (error) {observationError = error;}
  if (exchange === undefined) {
    await input.journal.terminal({ attemptId: execution.attemptId, payloadSha256: sha256Json({
      providerFailureCode: result.status === "available" ? null : result.code,
      reason: "retrieval_external_effect_unknown",
      telemetryEvidence: observationError === undefined ? "present" : "missing_or_invalid",
    }), phase: "retrieval", state: "outcome_unknown" });
    throw new Error("retrieval external effect is unknown and terminal", { cause: exactExchangeError });
  }
  return { exchange, observation, observationError };
}

async function validateAndAuditRetrieval(input: CanonicalEngineInput,
  execution: RetrievalExecution, result: Awaited<ReturnType<typeof invokeRetrieval>>,
  captured: Awaited<ReturnType<typeof captureRetrieval>>):
Promise<CanonicalRetrievalBindingV1 | null | "invalid"> {
  try {
    await sealRetrievalExchange(input.audit, execution.attemptId, captured.exchange);
    const retrievalBinding = execution.prepared.schemaVersion === 3 ? await createV3Binding(
      input, execution, result, captured.exchange) : null;
    if (captured.observation === undefined) {throw captured.observationError;}
    const telemetry = validateCanonicalRetrievalObservation({ attemptId: execution.attemptId,
      exchange: captured.exchange, observation: captured.observation });
    await input.audit.seal({ attemptId: execution.attemptId, kind: "retrieval_observation",
      plaintext: utf8(canonicalJson(telemetry)) });
    return retrievalBinding;
  } catch {
    const failureReason = result.status === "available" ?
      "retrieval_observation_evidence_invalid" : result.code;
    await input.journal.terminal({ attemptId: execution.attemptId, payloadSha256: sha256Json({
      reason: failureReason, telemetryEvidence: "missing_or_invalid" }),
    phase: "retrieval", state: "failed" });
    return "invalid";
  }
}

async function createV3Binding(input: CanonicalEngineInput, execution: RetrievalExecution,
  result: Awaited<ReturnType<typeof invokeRetrieval>>,
  exchange: InfinityContextRetrievalV2ExactExchange) {
  if (!isV3ExactExchange(exchange)) {throw new Error("V3 exchange binding missing");}
  if (execution.prepared.schemaVersion !== 3) {throw new Error("V3 prepared request is missing");}
  const binding = await createCanonicalRetrievalBinding({ attemptId: execution.attemptId,
    packet: execution.packet, topology: execution.topology,
    diagnosticPlanSha256: input.store instanceof DiagnosticFrozenStore ?
      custodyDigest({ plan: input.store.plan, remoteDocumentIds: input.store.remoteDocumentIds }) : null,
    request: execution.prepared, exchange });
  await input.audit.seal({ attemptId: execution.attemptId, kind: "retrieval_binding",
    plaintext: utf8(custodyJson(binding)) });
  const projected = result.status === "available" ? result.candidates.map(candidate => ({
    contributions: candidate.retrievalProvenance.contributions,
    fusedScore: candidate.retrievalProvenance.fusedScore, locatorId: candidate.locator,
    providerRank: candidate.retrievalProvenance.providerRank })) : [];
  if ((result.status === "available") !== (binding.providerStatus === "available") ||
    custodyDigest(projected) !== binding.candidateProjectionSha256) {
    throw new Error("V3 candidate inventory differs from official bytes");
  }
  return binding;
}

function isV3ExactExchange(exchange: InfinityContextRetrievalV2ExactExchange):
exchange is InfinityContextRetrievalV3ExactExchange {
  return "schemaVersion" in exchange && exchange.schemaVersion === 2 &&
    "contractVersion" in exchange && exchange.contractVersion === "context-retrieval.v3" &&
    "capabilityRoute" in exchange && exchange.capabilityRoute === "/v1/context/retrieve-v3/capability" &&
    "retrievalRoute" in exchange && exchange.retrievalRoute === "/v1/context/retrieve-v3";
}

async function sealRetrievalExchange(audit: QualificationEncryptedAuditPort, attemptId: string,
  exchange: InfinityContextRetrievalV2ExactExchange): Promise<void> {
  const settled = await Promise.allSettled([
    audit.seal({ attemptId, kind: "capability_request", plaintext: exchange.capabilityRequestBytes }),
    audit.seal({ attemptId, kind: "capability_response", plaintext: exchange.capabilityResponseBytes }),
    audit.seal({ attemptId, kind: "retrieval_request", plaintext: exchange.requestBytes }),
    audit.seal({ attemptId, kind: "retrieval_response", plaintext: exchange.responseBytes }),
  ]);
  const failure = settled.find((value): value is PromiseRejectedResult => value.status === "rejected");
  if (failure !== undefined) {throw failure.reason;}
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function utf8(value: string): Uint8Array {return new TextEncoder().encode(value);}
