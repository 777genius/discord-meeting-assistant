import { assertExpectedAttempt } from "./canonical-answer-artifact-validation.js";
import { canonicalJson } from "./canonical.js";
import type { validateCanonicalScopeResolutionObservation } from
  "./canonical-metadata-contract.js";
import type { decodeQualificationQuestionOutcome } from
  "./execute-admitted-qualification-question.js";
import type { MainCanonicalEvidenceProjection, QualificationScopeTopology } from
  "./production-ports.js";

/** Authenticates a completed preparation failure without implying retrieval provider activity. */
export async function verifyPreRetrievalFailureProjection(input: {
  readonly expected: MainCanonicalEvidenceProjection;
  readonly outcome: ReturnType<typeof decodeQualificationQuestionOutcome>;
  readonly resolveTopology: () => Promise<QualificationScopeTopology>;
  readonly scope: ReturnType<typeof validateCanonicalScopeResolutionObservation>;
}): Promise<void> {
  const { expected, outcome, scope } = input;
  assertExpectedAttempt(expected);
  if (!["empty", "unavailable"].includes(scope.status) || outcome.status !== "failed" ||
    outcome.reason !== `request_${scope.status}` || outcome.rawRetrievalResponseSha256 !== null ||
    outcome.retrievalCandidates.length !== 0 || outcome.selectedTurns.length !== 0 ||
    outcome.citations.length !== 0 || outcome.claims.length !== 0 || expected.answerAbstained ||
    !Number.isSafeInteger(expected.retrievalLatencyUs) || expected.retrievalLatencyUs < 0) {
    throw new Error(
      "canonical scope resolution observation differs from the pre-retrieval outcome branch");
  }
  if (expected.executionPacket.schemaVersion !==
    "meeting_knowledge.qualification_execution_packet.v2") {
    return;
  }
  const topology = Object.freeze({ ...await input.resolveTopology() });
  if (topology.topologyDocumentSha256 !== expected.executionPacket.scopeTopologyDocumentSha256 ||
    topology.topologyGeneration !== expected.executionPacket.scopeTopologyGeneration ||
    typeof topology.spaceId !== "string" || topology.spaceId.trim() === "" ||
    typeof topology.memoryScopeId !== "string" || topology.memoryScopeId.trim() === "") {
    throw new Error("pre-retrieval failure topology differs from independent admission");
  }
}

export function assertCanonicalOutcomeProjection(outcome: ReturnType<
  typeof decodeQualificationQuestionOutcome>, expected: MainCanonicalEvidenceProjection): void {
  const ranked = outcome.retrievalCandidates.map(({ locatorId }) => locatorId);
  const evidenceLocators = outcome.selectedTurns.map(({ sourceLocatorId }) => sourceLocatorId);
  const turnIds = outcome.selectedTurns.map(({ turnId }) => turnId);
  const byTurn = new Map(outcome.selectedTurns.map((turn) => [turn.turnId, turn.sourceLocatorId]));
  const citationLocators = outcome.citations.map((turnId) => byTurn.get(turnId));
  if (citationLocators.some((value) => value === undefined) ||
    canonicalJson(ranked) !== canonicalJson(expected.rankedLocatorIds) ||
    canonicalJson(evidenceLocators) !== canonicalJson(expected.evidenceLocatorIds) ||
    canonicalJson(turnIds) !== canonicalJson(expected.evidenceTurnIds) ||
    canonicalJson(citationLocators) !== canonicalJson(expected.citationLocatorIds)) {
    throw new Error("canonical outcome locators or turns differ from external evidence");
  }
}
