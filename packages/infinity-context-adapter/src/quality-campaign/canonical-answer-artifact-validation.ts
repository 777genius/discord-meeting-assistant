import { createFocusedRetrievalGroundingPlan } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { buildSubscriptionRuntimeKnowledgeAnswerRequest, serializeSubscriptionRuntimeTaskRequest,
  stableSubscriptionRuntimeId, subscriptionRuntimeTranscriptVersionFromRequestBytes } from
  "@discord-meeting/subscription-runtime-adapter";

import { canonicalJson, digest, exactRecord, sha256 as canonicalSha256 } from "./canonical.js";
import { attemptIdentity } from "./execution.js";
import type { SemanticQualityV4ArtifactKind } from "./canonical-metadata-contract.js";
import { decodeQualificationQuestionOutcome } from
  "./execute-admitted-qualification-question.js";
import type { MainCanonicalEvidenceProjection } from "./production-ports.js";
import { readProductionCanonicalArtifact } from
  "./production-canonical-execution-evidence.js";

type OpenedArtifacts = Map<SemanticQualityV4ArtifactKind, Awaited<ReturnType<
  typeof readProductionCanonicalArtifact>>>;
type QualificationOutcome = ReturnType<typeof decodeQualificationQuestionOutcome>;

type AnswerRequest = ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest>;

type CanonicalAnswerRequestIntent = Readonly<{
  readonly attemptId: string;
  readonly reason: string;
  readonly schemaVersion: "meeting_knowledge.canonical_answer_request_intent.v1";
  readonly status: "not_prepared";
} | {
  readonly attemptId: string;
  readonly requestBase64: string;
  readonly requestSha256: string;
  readonly schemaVersion: "meeting_knowledge.canonical_answer_request_intent.v1";
  readonly status: "prepared";
}>;

/** Retains preparation separately from a transport exchange, which may never be sent. */
export function preparedAnswerRequestIntentBytes(attemptId: string,
  request: AnswerRequest): Uint8Array {
  const requestBytes = serializeSubscriptionRuntimeTaskRequest(request);
  return utf8(canonicalJson({ attemptId, requestBase64: Buffer.from(requestBytes).toString("base64"),
    requestSha256: canonicalSha256({ effectKind: "answer", request }),
    schemaVersion: "meeting_knowledge.canonical_answer_request_intent.v1",
    status: "prepared" }));
}

/** Explicitly records that the application never prepared, reserved, or sent an answer request. */
export function absentAnswerRequestIntentBytes(attemptId: string,
  reason: string | undefined): Uint8Array {
  if (reason === undefined || reason.trim() === "") {
    throw new Error("unprepared answer intent requires a terminal reason");
  }
  return utf8(canonicalJson({ attemptId, reason,
    schemaVersion: "meeting_knowledge.canonical_answer_request_intent.v1",
    status: "not_prepared" }));
}

export function absentAnswerRequestIntentSha256(attemptId: string, reason: string): string {
  return canonicalSha256({ effectKind: "answer", requestIntent: {
    attemptId, reason, status: "not_prepared" } });
}

export function verifyAnswerRequestIntent(bytes: Uint8Array,
  expected: MainCanonicalEvidenceProjection, outcome: QualificationOutcome,
  memoryGeneration: string | null): { readonly prepared: boolean } {
  const intent = decodeAnswerRequestIntent(bytes);
  if (intent.attemptId !== expected.attemptId) {
    throw new Error("answer request intent belongs to another attempt");
  }
  if (intent.status === "not_prepared") {
    if (outcome.selectedTurns.length !== 0 || outcome.reason !== intent.reason ||
      expected.terminalAnswerRequestSha256 !==
        absentAnswerRequestIntentSha256(expected.attemptId, intent.reason)) {
      throw new Error("unprepared answer intent differs from terminal outcome evidence");
    }
    return Object.freeze({ prepared: false });
  }
  if (outcome.selectedTurns.length === 0 || memoryGeneration === null) {
    throw new Error("prepared answer intent has no independently retained evidence");
  }
  const requestBytes = Buffer.from(intent.requestBase64, "base64");
  if (requestBytes.toString("base64") !== intent.requestBase64 || requestBytes.byteLength === 0 ||
    requestBytes.byteLength > 32_768) {
    throw new Error("prepared answer request intent is not bounded canonical bytes");
  }
  const reconstructed = reconstructAnswerRequest(expected, outcome,
    subscriptionRuntimeTranscriptVersionFromRequestBytes(requestBytes), memoryGeneration);
  if (!Buffer.from(serializeSubscriptionRuntimeTaskRequest(reconstructed)).equals(requestBytes) ||
    canonicalSha256({ effectKind: "answer", request: reconstructed }) !== intent.requestSha256 ||
    intent.requestSha256 !== expected.terminalAnswerRequestSha256) {
    throw new Error("prepared answer request intent differs from independently reconstructed evidence");
  }
  return Object.freeze({ prepared: true });
}

export function assertExpectedAttempt(expected: MainCanonicalEvidenceProjection): void {
  const { attemptId: _attemptId, ...identityInput } = expected.identity;
  const reconstructed = attemptIdentity(identityInput);
  if (reconstructed.attemptId !== expected.attemptId || expected.identity.callKind !== "answer" ||
    expected.identity.callOrdinal !== 0 || expected.identity.questionId !==
      expected.executionPacket.questionId || expected.identity.questionDigestSha256 !==
      canonicalSha256(expected.executionPacket) || expected.executionPacket.locale.trim() === "" ||
    expected.executionPacket.questionText.trim() === "") {
    throw new Error("local canonical attempt differs from independently admitted execution");
  }
}

export async function verifyAnswerArtifacts(opened: OpenedArtifacts,
  expected: MainCanonicalEvidenceProjection, outcome: QualificationOutcome,
  memoryGeneration: string, repairPresent: boolean): Promise<void> {
  const artifactBytes = (kind: SemanticQualityV4ArtifactKind) => opened.get(kind)!.plaintext;
  const reconstructed = reconstructAnswerRequest(expected, outcome,
    subscriptionRuntimeTranscriptVersionFromRequestBytes(artifactBytes("answer_original_request")),
    memoryGeneration);
  if (!Buffer.from(serializeSubscriptionRuntimeTaskRequest(reconstructed)).equals(
    artifactBytes("answer_original_request"))) {
    throw new Error("original answer request differs from independently reconstructed evidence");
  }
  assertModelSurface(reconstructed, artifactBytes("answer_original_model_surface"), "original");
  if (canonicalSha256({ effectKind: "answer", request: reconstructed }) !==
    expected.terminalAnswerRequestSha256) {
    throw new Error("original answer request differs from external terminal evidence");
  }
  if (repairPresent) {
    const repairRequest = repairRequestFrom(reconstructed);
    if (!Buffer.from(serializeSubscriptionRuntimeTaskRequest(repairRequest)).equals(
      artifactBytes("answer_repair_request"))) {
      throw new Error("repair answer request is substituted or swapped with original");
    }
    assertModelSurface(repairRequest, artifactBytes("answer_repair_model_surface"), "repair");
  }
}

function reconstructAnswerRequest(expected: MainCanonicalEvidenceProjection,
  outcome: QualificationOutcome, transcriptVersion: number, memoryGeneration: string) {
  const binding = { canonicalEvidenceHash: canonicalSha256(
      outcome.selectedTurns.map(({ turnHash }) => turnHash)), memoryGeneration, transcriptVersion };
  const plan = createFocusedRetrievalGroundingPlan({ authorityGeneration: binding.memoryGeneration,
    coverage: "sufficient", humanActorIds: [...new Set(outcome.selectedTurns.map(({ speakerId }) => speakerId))],
    turns: outcome.selectedTurns });
  return buildSubscriptionRuntimeKnowledgeAnswerRequest({ attemptId: expected.attemptId, binding,
    locale: expected.executionPacket.locale, plan, question: expected.executionPacket.questionText }, {
    isolatedCwd: "/run/discord-meeting-subscription-runtime/workspace",
    maxOutputTokens: 2_048, timeoutMs: 180_000 });
}

function assertModelSurface(request: ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest>,
  retained: Uint8Array, label: string): void {
  const expected = [request.task.systemPrompt, request.task.prompt,
    JSON.stringify(request.task.controls.outputSchema)].join("\n");
  if (new TextDecoder("utf-8", { fatal: true }).decode(retained) !== expected) {
    throw new Error(`${label} answer model surface is substituted`);
  }
}

function repairRequestFrom(original: ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest>):
ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest> {
  const runId = stableSubscriptionRuntimeId("knowledge-answer-provider-output-repair",
    original.runId);
  return { ...original, context: { ...original.context, correlationId: runId }, runId,
    task: { ...original.task, systemPrompt: [original.task.systemPrompt,
      "A previous generation failed strict output validation. Regenerate once from the original supplied question and evidence and obey every schema bound exactly.",
      "In particular, claims=[] with status=answered is forbidden. Decide answerability before emitting claims: for an answerable question populate claims with at least one concise supported claim and its direct evidenceIds, then emit status=answered; otherwise keep claims=[] and emit insufficient_evidence or not_a_question.",
    ].join(" ") } };
}

function decodeAnswerRequestIntent(bytes: Uint8Array): CanonicalAnswerRequestIntent {
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("answer request intent is not canonical JSON");
  }
  if (canonicalJson(value) !== text) {
    throw new Error("answer request intent is not canonical JSON");
  }
  const candidate = value as Record<string, unknown>;
  const prepared = candidate.status === "prepared";
  const record = exactRecord(value, prepared ? ["attemptId", "requestBase64", "requestSha256",
    "schemaVersion", "status"] : ["attemptId", "reason", "schemaVersion", "status"],
  "answer request intent");
  if (record.schemaVersion !== "meeting_knowledge.canonical_answer_request_intent.v1" ||
    typeof record.attemptId !== "string" || prepared &&
      (typeof record.requestBase64 !== "string" || typeof record.requestSha256 !== "string") ||
    !prepared && (record.status !== "not_prepared" || typeof record.reason !== "string" ||
      record.reason.trim() === "")) {
    throw new Error("answer request intent is invalid");
  }
  if (prepared) {
    digest(record.requestSha256, "prepared answer request intent");
  }
  return record as unknown as CanonicalAnswerRequestIntent;
}

function utf8(value: string): Uint8Array {return new TextEncoder().encode(value);}
