import { scopeObservation } from "./quality-campaign-scope-observation-fixture.js";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createFocusedRetrievalGroundingPlan } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { buildSubscriptionRuntimeKnowledgeAnswerRequest, knowledgeAnswerExchangeInventorySha256,
  serializeSubscriptionRuntimeTaskRequest } from
  "@discord-meeting/subscription-runtime-adapter";

import { preparedAnswerRequestIntentBytes } from
  "../src/quality-campaign/canonical-answer-artifact-validation.js";
import { canonicalJson, sha256 } from "../src/quality-campaign/canonical.js";
import { attemptIdentity } from "../src/quality-campaign/execution.js";
import { createProductionCanonicalExecutionEvidence } from
  "../src/quality-campaign/production-canonical-execution-evidence.js";
import { retentionCheckpointReceipt } from
  "../src/quality-campaign/production-checkpoints.js";
import { loadMainExecutionEvidence } from
  "../src/quality-campaign/production-execution-evidence.js";
import { createProductionLocalCanonicalEvidenceReader } from
  "../src/quality-campaign/production-local-canonical-evidence-reader.js";
import { assertExactOutcomeContract, type ExactCampaignEvidence, type ExactOutcomeEvidence } from
  "../src/quality-campaign/production-evidence.js";

describe("main external/local retention binding", () => {
  it("loads external custody, verifies concrete local artifacts, and checkpoints their digest",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "main-local-retention-"));
      const artifactRoot = join(root, "artifacts"); const artifactKey = new Uint8Array(32).fill(3);
      const campaignRootSha256 = "a".repeat(64); const releaseRootSha256 = "b".repeat(64);
      const locator = "c".repeat(64);
      const packet = { locale: "en" as const, questionId: "q-1", questionText: "Question?",
        scopeTopologyReference: "signed:q-1", source: "independent_review" as const };
      const question = { locale: "en" as const, questionDigestSha256: sha256(packet),
        questionId: "q-1", rubricDigestSha256: "e".repeat(64),
        source: "independent_review" as const };
      const spendReservationSha256ByRepetition = { 1: "1".repeat(64), 2: "2".repeat(64),
        3: "3".repeat(64) } as const;
      const outcomes: ExactOutcomeEvidence[] = [];
      for (const repetition of [1, 2, 3] as const) {
        const identity = attemptIdentity({ callKind: "answer", callOrdinal: 0,
          campaignRootSha256, questionDigestSha256: question.questionDigestSha256,
          questionId: question.questionId, releaseRootSha256, repetition,
          spendReservationSha256: spendReservationSha256ByRepetition[repetition] });
        const capabilityRequest = new Uint8Array();
        const capabilityResponse = bytes(canonicalJson({ capability: repetition }));
        const retrievalRequest = bytes(canonicalJson({ query: repetition }));
        const retrievalResponse = bytes(canonicalJson({ locators: [locator] }));
        const evidence = createProductionCanonicalExecutionEvidence({ answerJournalRoot:
          join(root, "answer"), artifactKey, artifactKeyId: "synthetic-key", artifactRoot,
        attemptId: identity.attemptId, questionId: question.questionId, repetition,
        retrievalJournalRoot: join(root, "retrieval"), rootBindingSha256: campaignRootSha256 });
        const observation = { attemptId: identity.attemptId,
          capabilityAndRetrievalLatencyUs: 10 + repetition,
          capabilityBytes: capabilityResponse.byteLength,
          capabilitySha256: hash(capabilityResponse), requestBytes: retrievalRequest.byteLength,
          requestSha256: hash(retrievalRequest), responseBytes: retrievalResponse.byteLength,
          responseSha256: hash(retrievalResponse), routeLatencyUs: repetition,
          schemaVersion: "meeting_knowledge.canonical_retrieval_observation.v1" };
        const turn = { endMs: 2, sourceLocatorId: locator, speakerId: "speaker-1", startMs: 1,
          text: "Synthetic evidence", turnHash: "d".repeat(64), turnId: "turn-1" };
        const normalized = { citations: [turn.turnId], claims: ["Synthetic claim"],
          rawRetrievalResponseSha256: hash(retrievalResponse), retrievalCandidates:
          [{ contributions: [], fusedScore: 1, locatorId: locator, providerRank: 0 }],
          selectedTurns: [turn], status: "answered" };
        const memoryGeneration = `postgres-memory-generation-${repetition}`;
        const answerBinding = { canonicalEvidenceHash: sha256([turn.turnHash]),
          memoryGeneration, transcriptVersion: 1 };
        const answerPlan = createFocusedRetrievalGroundingPlan({ authorityGeneration:
          memoryGeneration, coverage: "sufficient", humanActorIds: [turn.speakerId],
          turns: [turn] });
        const answerRequest = buildSubscriptionRuntimeKnowledgeAnswerRequest({
          attemptId: identity.attemptId, binding: answerBinding, locale: packet.locale,
          plan: answerPlan, question: packet.questionText }, {
          executionProfile: "sealed_qualification",
          isolatedCwd: "/run/discord-meeting-subscription-runtime/workspace",
          maxOutputTokens: 2_048, timeoutMs: 180_000 });
        const answerRequestBytes = serializeSubscriptionRuntimeTaskRequest(answerRequest);
        const answerResponse = bytes(canonicalJson({ answer: repetition }));
        const answerSurface = bytes([answerRequest.task.systemPrompt, answerRequest.task.prompt,
          JSON.stringify(answerRequest.task.controls.outputSchema)].join("\n"));
        const answerRequestIntentSha256 = sha256({ effectKind: "answer", request: answerRequest });
        const answerExchangeInventorySha256 = knowledgeAnswerExchangeInventorySha256([{
          callOrdinal: "original", requestBytes: answerRequestBytes,
          responseBytes: answerResponse }]);
        for (const [kind, plaintext] of [["capability_request", capabilityRequest],
          ["capability_response", capabilityResponse], ["retrieval_request", retrievalRequest],
          ["retrieval_response", retrievalResponse],
          ["retrieval_observation", bytes(canonicalJson(observation))],
          ["scope_resolution_observation", bytes(canonicalJson(scopeObservation(identity)))],
          ["selected_canonical_turns", bytes(JSON.stringify({ attemptId: identity.attemptId,
            memoryGeneration, schemaVersion: "meeting_knowledge.selected_canonical_turns.v2",
            turns: [turn] }))],
          ["answer_request_intent", preparedAnswerRequestIntentBytes(identity.attemptId,
            answerRequest, memoryGeneration)],
          ["answer_execution_observation", bytes(canonicalJson({ attemptId: identity.attemptId,
            outcomeCertain: true, providerBytesSent: true,
            schemaVersion: "meeting_knowledge.canonical_answer_execution_observation.v2",
            terminalReason: null }))],
          ["answer_original_model_surface", answerSurface],
          ["answer_original_request", answerRequestBytes],
          ["answer_original_response", answerResponse],
          ["answer_normalized_outcome", bytes(JSON.stringify(normalized))]] as const) {
          await evidence.audit.seal({ attemptId: identity.attemptId, kind, plaintext });
        }
        const terminal = (callKind: "answer" | "capability" | "retrieval",
          requestDigestSha256: string, resultEnvelopeDigestSha256: string) => ({ attemptId:
          attemptIdentity({ ...identity, callKind }).attemptId, callKind, callOrdinal: 0,
        predecessorResultDigestSha256: null, requestDigestSha256, resultEnvelopeDigestSha256,
        signedResult: {}, terminalDigestSha256: "f".repeat(64) });
        outcomes.push({ answerAbstained: false,
          answerExchangeInventorySha256,
          answerRequestIntentSha256, artifactBindingSha256ByKind: {},
          attemptId: identity.attemptId, campaignRootSha256, citationLocatorDigests: [locator],
          evidenceLocatorDigests: [locator], evidenceTurnIds: [turn.turnId],
          expectedAnswer: "answerable", finalAdjudicationSha256: "4".repeat(64),
          forbiddenLocatorDigests: [], identity, providerCallInventory: [
            { callKind: "capability", callOrdinal: 0 },
            { callKind: "retrieval", callOrdinal: 0 },
            { callKind: "answer", callOrdinal: 0 }], questionDigestSha256:
          question.questionDigestSha256, questionId: question.questionId,
          rankedLocatorDigests: [locator], relevantLocatorDigests: [locator], repetition,
          retrievalLatencyUs: observation.capabilityAndRetrievalLatencyUs,
          schemaVersion: "meeting_knowledge.semantic_quality_exact_outcome.v2",
          scopeViolationLocatorIds: [], speakerTimeChecks: [], terminalChain: [
            terminal("capability", hash(capabilityRequest), hash(capabilityResponse)),
            terminal("retrieval", hash(retrievalRequest), hash(retrievalResponse)),
            terminal("answer", answerRequestIntentSha256, answerExchangeInventorySha256)],
          terminalReason: null,
          terminalStatus: "answered" });
      }
      const externalEvidence: ExactCampaignEvidence = { adjudications: [], artifacts: [],
        authorizedLocatorIds: [], authorizedLocatorInventory: {}, campaignByteCeiling: 1,
        finalRootBindingSha256: "7".repeat(64), forbiddenLocatorReceipt: {},
        goldRelevanceReceipt: {}, outcomes, questionReviewReceipts: [{}, {}],
        repetitionEvidence: [] };
      const loaded = await loadMainExecutionEvidence({ campaignRootSha256,
        deadlineEpochMs: Date.now() + 5_000, ports: { evidence: {
          holdout: async () => {throw new Error("holdout must not be called");},
          main: async () => ({ envelopeBytes: bytes("external"), signedReceipt: {} }) },
        evidenceCustody: { open: async () => externalEvidence }, mainCanonicalEvidence:
          createProductionLocalCanonicalEvidenceReader({ artifactKey,
            artifactKeyId: "synthetic-key", artifactRoot, topology: async () => {
              throw new Error("legacy V1 must not resolve topology");
            } }) },
      executionPackets: [packet], questions: [question], releaseRootSha256,
      spendReservationSha256ByRepetition });
      const receipt = retentionCheckpointReceipt(campaignRootSha256, { inventorySha256:
        "8".repeat(64), metricsSha256ByRepetition: {} }, loaded.localEvidence.inventorySha256);
      expect(loaded.externalEvidence).toBe(externalEvidence);
      expect(receipt.digests.localCanonicalInventorySha256)
        .toBe(loaded.localEvidence.inventorySha256);
      for (const field of ["answerRequestIntentSha256", "answerExchangeInventorySha256"] as const) {
        expect(() => {
          assertExactOutcomeContract({ ...outcomes[0]!, [field]: "0".repeat(64) });
        }).toThrow("answer evidence is detached");
      }
      expect(() => {assertExactOutcomeContract({ ...outcomes[0]!,
        providerCallInventory: outcomes[0]!.providerCallInventory.slice(0, 2),
        terminalChain: outcomes[0]!.terminalChain.slice(0, 2) });})
        .toThrow("without an answer call");
      const { schemaVersion: _schemaVersion, ...legacy } = outcomes[0]!;
      expect(() => {assertExactOutcomeContract(legacy as ExactOutcomeEvidence);}).toThrow();
    });
});

function bytes(value: string): Uint8Array {return new TextEncoder().encode(value);}
function hash(value: Uint8Array): string {return createHash("sha256").update(value).digest("hex");}
