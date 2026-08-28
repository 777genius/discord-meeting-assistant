import { describe, expect, it } from "vitest";

import {
  AdmitCurrentFinalReply,
  type LocalFinalReplyPolicy,
  type QuestionAdmissionCommitPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import { authorizationPolicyVersion, authority, AuthorizationFake, EvidenceFake } from
  "./local-final-reply-application-fixtures.test.js";

const policy: LocalFinalReplyPolicy = {
  admission: { guildQuestionsPerHour: 100, jobTtlSeconds: 900,
    requesterQuestionsPerHour: 10 },
  answerMessageMaximumCharacters: 2_000,
  authorizationPolicyVersion,
  groundingSafety: { maximumRequestBytes: 100_000, modelContextTokens: 128_000,
    outputTokensReserved: 2_048, reasoningTokensReserved: 4_096,
    safeInputTokens: 100_000, tokenDriftReserve: 8_192 },
  jobLeaseSeconds: 60,
  maximumProviderAttempts: 2,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
  retrieval: { maximumCandidates: 24, neighborTurns: 2 },
  retrievalAdmission: { cutoverEpoch: "test-cutover-r1",
    infinityProfileFingerprint: "e".repeat(64),
    localProfileFingerprint: "f".repeat(64) },
};

describe("current final reply admission", () => {
  it("admits a first meeting on the explicit bounded local path without an index plan", async () => {
    const commits: Parameters<QuestionAdmissionCommitPort["commit"]>[0][] = [];
    const admissions: QuestionAdmissionCommitPort = {
      commit: (input) => {
        commits.push(input);
        return Promise.resolve({ jobId: "question-1", status: "committed" });
      },
      withdrawProjection: () => Promise.resolve([]),
    };
    const useCase = new AdmitCurrentFinalReply(
      new EvidenceFake(), new AuthorizationFake(), admissions, policy,
      { prepare: () => Promise.resolve(null) },
    );

    await expect(useCase.execute({
      authorizationPrincipalRef: "principal:v1:opaque",
      deliveryContainerId: "question-thread-1",
      finalProjectionReceipt: authority.finalProjectionReceipt,
      projectionTargetContainerId: authority.projectionTargetContainerId,
      questionHash: "c".repeat(64), questionId: "question-first-meeting",
      questionText: "What was decided?", requesterSubject: "d".repeat(64),
      schemaVersion: 2, scopeId: authority.scopeId,
    })).resolves.toEqual({ jobId: "question-1", status: "accepted" });
    expect(commits[0]?.binding.retrievalBinding).toEqual({
      cutoverEpoch: policy.retrievalAdmission.cutoverEpoch,
      profileFingerprint: policy.retrievalAdmission.localProfileFingerprint,
      retrievalPath: "canonical_local_exact_lexical_v1",
    });
  });
});
