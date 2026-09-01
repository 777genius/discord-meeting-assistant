import {
  v4EvaluationQuestionText,
  type FrozenSemanticQualityCorpusV4,
} from "./semantic-quality-v4-corpus.js";
import {
  createV4GeneratedClaimId,
  type V4EvaluationOutcome,
} from "./semantic-quality-v4-evaluation.js";
import { canonicalSha256 } from "./semantic-quality-v4-manifest.js";

export function perfectOutcomesForP0Test(
  corpus: FrozenSemanticQualityCorpusV4,
): V4EvaluationOutcome[] {
  const turns = new Map(corpus.primaryMeeting.humanTurns.map((turn) => [turn.turnId, turn]));
  return [...corpus.automatedQuestions, ...corpus.humanReviewQuestions].map((question) => {
    const claims = question.expectedClaimIds.map((goldClaimId, index) => {
      const turnId = question.goldTurnIds[index] ?? question.goldTurnIds[0];
      if (turnId === undefined) {throw new Error(`missing P0 fixture turn ID for ${question.id}`);}
      const turn = turns.get(turnId);
      if (turn === undefined) {throw new Error(`missing P0 fixture turn for ${question.id}`);}
      const citationRefs = [{ endMs: turn.endMs, speakerId: turn.speakerId,
        startMs: turn.startMs, turnId }];
      const text = `Synthetic structural answer for ${question.id} claim ${goldClaimId}`;
      const claimPayloadSha256 = canonicalSha256({ factual: true, text });
      return { citationRefs, claimId: createV4GeneratedClaimId({ citationRefs,
        claimOrdinal: index, claimPayloadSha256, factual: true, queryId: question.id }),
      claimPayloadSha256, factual: true, text };
    });
    const locallyRehydratedEvidence = claims.flatMap((claim) =>
      claim.citationRefs.map(({ turnId }) => {
        const evidence = turns.get(turnId);
        if (evidence === undefined) {throw new Error(`missing P0 evidence turn ${turnId}`);}
        return { ...evidence, sourceLocatorId: turnId };
      }));
    const prompt = `Answer the canonical evaluation question ${question.id} from admitted evidence.`;
    const userPromptBytes = new TextEncoder().encode(prompt).byteLength;
    const originalInput = { fullInputBytes: userPromptBytes + 42,
      outputSchemaBytes: 20, systemPromptBytes: 20, userPromptBytes };
    const repairInput = { fullInputBytes: userPromptBytes + 82,
      outputSchemaBytes: 20, systemPromptBytes: 60, userPromptBytes };
    return {
      adjudicationLatencyUs: 100_000,
      adjudicationKind: "synthetic_structural_fixture" as const,
      adjudications: claims.map((claim, index) => ({ claimId: claim.claimId,
        factuality: "factual" as const,
        matchedGoldClaimId: question.expectedClaimIds[index] ?? null,
        status: "finalized" as const, verdict: "supported" as const })),
      answer: { claims, status: question.kind === "answerable" ? "answered" as const :
        "abstained" as const },
      answerMeasurement: { answerLatencyUs: 300_000, attemptId: `fixture-${question.id}`,
        originalInput,
        originalModelInputSha256: canonicalSha256({ id: question.id, kind: "original-input" }),
        originalProviderRequestSha256: canonicalSha256({ id: question.id, kind: "provider-request" }),
        originalProviderResponseSha256: canonicalSha256({ id: question.id, kind: "provider-response" }),
        repairInput,
        repairModelInputSha256: canonicalSha256({ id: question.id, kind: "repair-input" }),
        repairProviderRequestSha256: null, repairProviderResponseSha256: null,
        responseBytes: 128, runtimeReceiptSha256: canonicalSha256({ id: question.id,
          kind: "runtime" }), responseRuntimeArtifactSha256: canonicalSha256({ id: question.id,
          kind: "response-runtime-artifact" }) },
      citationEntailments: claims.flatMap((claim) => claim.citationRefs.map(({ turnId }) => ({
        claimId: claim.claimId, status: "finalized" as const, turnId,
        verdict: "entails" as const,
      }))),
      evidenceBytes: new TextEncoder().encode(JSON.stringify(locallyRehydratedEvidence)).byteLength,
      fullLatencyUs: 550_000,
      locallyRehydratedEvidence,
      locale: question.locale,
      prompt,
      promptBytes: repairInput.fullInputBytes,
      queryId: question.id,
      questionDigestSha256: canonicalSha256({ id: question.id, locale: question.locale,
        v4EvaluationQuestionText: v4EvaluationQuestionText(question) }),
      retrieval: { capabilityAndRetrievalLatencyUs: 200_000, capabilityBytes: 512,
        capabilitySha256: canonicalSha256({ id: question.id, kind: "capability" }),
        expandedNeighborLocators: [], latencyUs: 200_000,
        rankedSeedLocators: question.goldLocatorRelevance.map(({ locatorId }) => ({ locatorId })),
        requestBytes: 256, requestSha256: canonicalSha256({ id: question.id, kind: "request" }),
        requestSnapshotSha256: canonicalSha256({ id: question.id, kind: "request-snapshot" }),
        responseBytes: question.kind === "answerable" ? 128 : 32,
        responseSha256: canonicalSha256({ id: question.id, kind: "response" }),
        routeLatencyUs: 150_000,
        status: "completed" as const },
    };
  });
}
