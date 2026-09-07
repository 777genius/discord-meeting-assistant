import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/quality-campaign/canonical.js";
import { attemptIdentity } from "../src/quality-campaign/execution.js";
import { createProductionCanonicalExecutionEvidence } from
  "../src/quality-campaign/production-canonical-execution-evidence.js";
import { retentionCheckpointReceipt } from
  "../src/quality-campaign/production-checkpoints.js";
import { loadMainExecutionEvidence } from
  "../src/quality-campaign/production-execution-evidence.js";
import { createProductionLocalCanonicalEvidenceReader } from
  "../src/quality-campaign/production-local-canonical-evidence-reader.js";
import type { ExactCampaignEvidence, ExactOutcomeEvidence } from
  "../src/quality-campaign/production-evidence.js";

describe("main external/local retention binding", () => {
  it("loads external custody, verifies concrete local artifacts, and checkpoints their digest",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "main-local-retention-"));
      const artifactRoot = join(root, "artifacts"); const artifactKey = new Uint8Array(32).fill(3);
      const campaignRootSha256 = "a".repeat(64); const releaseRootSha256 = "b".repeat(64);
      const locator = "c".repeat(64);
      const question = { locale: "en" as const, questionDigestSha256: "d".repeat(64),
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
          text: "Synthetic evidence", turnHash: "turn-hash", turnId: "turn-1" };
        const normalized = { citations: [turn.turnId], claims: ["Synthetic claim"],
          rawRetrievalResponseSha256: hash(retrievalResponse), retrievalCandidates:
          [{ contributions: [], fusedScore: 1, locatorId: locator, providerRank: 0 }],
          selectedTurns: [turn], status: "answered" };
        for (const [kind, plaintext] of [["capability_request", capabilityRequest],
          ["capability_response", capabilityResponse], ["retrieval_request", retrievalRequest],
          ["retrieval_response", retrievalResponse],
          ["retrieval_observation", bytes(canonicalJson(observation))],
          ["answer_normalized_outcome", bytes(JSON.stringify(normalized))]] as const) {
          await evidence.audit.seal({ attemptId: identity.attemptId, kind, plaintext });
        }
        const terminal = (callKind: "answer" | "capability" | "retrieval",
          requestDigestSha256: string, resultEnvelopeDigestSha256: string) => ({ attemptId:
          attemptIdentity({ ...identity, callKind }).attemptId, callKind, callOrdinal: 0,
        predecessorResultDigestSha256: null, requestDigestSha256, resultEnvelopeDigestSha256,
        signedResult: {}, terminalDigestSha256: "f".repeat(64) });
        outcomes.push({ answerAbstained: false, artifactBindingSha256ByKind: {},
          attemptId: identity.attemptId, campaignRootSha256, citationLocatorDigests: [locator],
          evidenceLocatorDigests: [locator], evidenceTurnIds: [turn.turnId],
          expectedAnswer: "answerable", finalAdjudicationSha256: "4".repeat(64),
          forbiddenLocatorDigests: [], identity, questionDigestSha256:
          question.questionDigestSha256, questionId: question.questionId,
          rankedLocatorDigests: [locator], relevantLocatorDigests: [locator], repetition,
          retrievalLatencyUs: observation.capabilityAndRetrievalLatencyUs,
          scopeViolationLocatorIds: [], speakerTimeChecks: [], terminalChain: [
            terminal("capability", hash(capabilityRequest), hash(capabilityResponse)),
            terminal("retrieval", hash(retrievalRequest), hash(retrievalResponse)),
            terminal("answer", "5".repeat(64), "6".repeat(64))] });
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
            artifactKeyId: "synthetic-key", artifactRoot }) },
      questions: [question], releaseRootSha256, spendReservationSha256ByRepetition });
      const receipt = retentionCheckpointReceipt(campaignRootSha256, { inventorySha256:
        "8".repeat(64), metricsSha256ByRepetition: {} }, loaded.localEvidence.inventorySha256);
      expect(loaded.externalEvidence).toBe(externalEvidence);
      expect(receipt.digests.localCanonicalInventorySha256)
        .toBe(loaded.localEvidence.inventorySha256);
    });
});

function bytes(value: string): Uint8Array {return new TextEncoder().encode(value);}
function hash(value: Uint8Array): string {return createHash("sha256").update(value).digest("hex");}
