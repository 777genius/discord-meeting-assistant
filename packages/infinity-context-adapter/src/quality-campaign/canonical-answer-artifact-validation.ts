import { createFocusedRetrievalGroundingPlan } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { buildSubscriptionRuntimeKnowledgeAnswerRequest, serializeSubscriptionRuntimeTaskRequest,
  stableSubscriptionRuntimeId, subscriptionRuntimeTranscriptVersionFromRequestBytes } from
  "@discord-meeting/subscription-runtime-adapter";

import { sha256 as canonicalSha256 } from "./canonical.js";
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
