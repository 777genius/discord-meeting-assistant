import { createFocusedRetrievalGroundingPlan } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { buildSubscriptionRuntimeKnowledgeAnswerRequest } from
  "@discord-meeting/subscription-runtime-adapter";
import { describe, expect, it } from "vitest";

import { preparedAnswerRequestIntentBytes, verifyAnswerRequestIntent } from
  "../src/quality-campaign/canonical-answer-artifact-validation.js";
import { sha256 } from "../src/quality-campaign/canonical.js";
import { attemptIdentity } from "../src/quality-campaign/execution.js";

describe("canonical prepared answer intent", () => {
  it("authenticates a prepared no-exchange failure without inventing a sent request or response",
    () => {
      const campaignRootSha256 = "a".repeat(64);
      const packet = { locale: "en" as const, questionId: "q-1",
        questionText: "What was approved?",
        schemaVersion: "meeting_knowledge.qualification_execution_packet.v2" as const,
        scopeTopologyDocumentSha256: "b".repeat(64), scopeTopologyGeneration: "generation-1",
        scopeTopologyReference: "signed:scope", source: "automatic" as const };
      const identity = attemptIdentity({ callKind: "answer", callOrdinal: 0, campaignRootSha256,
        questionDigestSha256: sha256(packet), questionId: packet.questionId,
        releaseRootSha256: "c".repeat(64), repetition: 1,
        spendReservationSha256: "d".repeat(64) });
      const turn = { endMs: 2, sourceLocatorId: "locator-1", speakerId: "speaker-1",
        startMs: 1, text: "Approved.", turnHash: "e".repeat(64), turnId: "turn-1" };
      const memoryGeneration = "memory-generation-1";
      const binding = { canonicalEvidenceHash: sha256([turn.turnHash]), memoryGeneration,
        transcriptVersion: 1 };
      const plan = createFocusedRetrievalGroundingPlan({ authorityGeneration: memoryGeneration,
        coverage: "sufficient", humanActorIds: [turn.speakerId], turns: [turn] });
      const request = buildSubscriptionRuntimeKnowledgeAnswerRequest({ attemptId: identity.attemptId,
        binding, locale: packet.locale, plan, question: packet.questionText }, {
        isolatedCwd: "/run/discord-meeting-subscription-runtime/workspace",
        maxOutputTokens: 2_048, timeoutMs: 180_000 });
      const terminalAnswerRequestSha256 = sha256({ effectKind: "answer", request });
      const projection = { answerAbstained: false, attemptId: identity.attemptId,
        campaignRootSha256, capabilityRequestSha256: "1".repeat(64),
        capabilityResponseSha256: "2".repeat(64), citationLocatorIds: [],
        diagnosticCustody: null, evidenceLocatorIds: [turn.sourceLocatorId],
        evidenceTurnIds: [turn.turnId], executionPacket: packet, identity,
        rankedLocatorIds: [turn.sourceLocatorId], retrievalLatencyUs: 1,
        retrievalRequestSha256: "3".repeat(64), retrievalResponseSha256: "4".repeat(64),
        terminalAnswerRequestSha256, terminalAnswerResponseSha256: "5".repeat(64),
        topology: null };
      const outcome = { citations: [], claims: [], rawRetrievalResponseSha256: "4".repeat(64),
        reason: "runtime_unavailable", retrievalCandidates: [{ contributions: [], fusedScore: 1,
          locatorId: turn.sourceLocatorId, providerRank: 0 }], selectedTurns: [turn],
        status: "failed" as const };
      const intent = preparedAnswerRequestIntentBytes(identity.attemptId, request);

      expect(verifyAnswerRequestIntent(intent, projection, outcome, memoryGeneration))
        .toEqual({ prepared: true });
      expect(() => verifyAnswerRequestIntent(intent, {
        ...projection, terminalAnswerRequestSha256: "0".repeat(64) }, outcome, memoryGeneration))
        .toThrow("prepared answer request intent differs");
    });
});
