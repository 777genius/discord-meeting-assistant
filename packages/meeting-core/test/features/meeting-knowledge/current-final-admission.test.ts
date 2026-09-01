import { describe, expect, it, vi } from "vitest";

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
      { retrievalV2Admission: { prepare: () => Promise.resolve({
        reason: "no_history_or_index", status: "empty",
      }) } },
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
    expect(commits[0]?.binding.retrievalBinding).toMatchObject({
      canonicalEvidenceFilters: { relativeTimeInterval: null,
        requiresSpeakerMatch: false, speakerIds: [] },
      cutoverEpoch: policy.retrievalAdmission.cutoverEpoch,
      profileFingerprint: policy.retrievalAdmission.localProfileFingerprint,
      originalQuestion: "What was decided?",
      provenanceSchemaVersion: 1,
      retrievalPath: "canonical_local_exact_lexical_v1",
    });
  });

  it("does not create a job when configured history is revoked at admission", async () => {
    const commit = vi.fn();
    const useCase = new AdmitCurrentFinalReply(
      new EvidenceFake(), new AuthorizationFake(), {
        commit,
        withdrawProjection: () => Promise.resolve([]),
      }, policy, { retrievalV2Admission: { prepare: () => Promise.resolve({
        reason: "serving_not_authorized", status: "unavailable",
      }) } },
    );

    await expect(useCase.execute({
      authorizationPrincipalRef: "principal:v1:opaque",
      deliveryContainerId: "question-thread-1",
      finalProjectionReceipt: authority.finalProjectionReceipt,
      projectionTargetContainerId: authority.projectionTargetContainerId,
      questionHash: "c".repeat(64), questionId: "question-revoked",
      questionText: "What was decided?", requesterSubject: "d".repeat(64),
      schemaVersion: 2, scopeId: authority.scopeId,
    })).resolves.toEqual({ reason: "retrieval_unavailable", status: "ignored" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("seals multilingual aliases and relative time for canonical filtering", async () => {
    const commits: Parameters<QuestionAdmissionCommitPort["commit"]>[0][] = [];
    const admissions: QuestionAdmissionCommitPort = {
      commit: (input) => {
        commits.push(input);
        return Promise.resolve({ jobId: "question-filtered", status: "committed" });
      },
      withdrawProjection: () => Promise.resolve([]),
    };
    const useCase = new AdmitCurrentFinalReply(
      new EvidenceFake(), new AuthorizationFake(), admissions, policy,
      { canonicalSpeakerFilters: { aliases: { "speaker-b": ["Влад", "Vlad"] } } },
    );
    await useCase.execute({
      authorizationPrincipalRef: "principal:v1:opaque",
      deliveryContainerId: "question-thread-1",
      finalProjectionReceipt: authority.finalProjectionReceipt,
      projectionTargetContainerId: authority.projectionTargetContainerId,
      questionHash: "c".repeat(64), questionId: "question-filtered",
      questionText: "Что Влад решил с 07:00 до 08:00?",
      requesterSubject: "d".repeat(64), schemaVersion: 2, scopeId: authority.scopeId,
    });
    expect(commits[0]?.binding.retrievalBinding).toMatchObject({
      canonicalEvidenceFilters: {
        relativeTimeInterval: { endMs: 480_000, startMs: 420_000 },
        requiresSpeakerMatch: true, speakerIds: ["speaker-b"],
      },
      retrievalPath: "canonical_local_exact_lexical_v1",
    });
  });

  it.each([
    "What did Vlad decide between 25:60 and 26:00?",
    "What did Vlad decide between 08:00 and 07:00?",
    "What did Аli\u200bce decide?",
  ])("denies recognized invalid or confusable filters before admission: %s",
    async (questionText) => {
      const commit = vi.fn();
      const useCase = new AdmitCurrentFinalReply(
        new EvidenceFake(), new AuthorizationFake(), {
          commit,
          withdrawProjection: () => Promise.resolve([]),
        }, policy, { canonicalSpeakerFilters: {
          aliases: { "speaker-b": ["Alice", "Vlad"] },
          identitySkeletons: { skeleton: (value) => {
            const canonical = value.normalize("NFKC").toLocaleLowerCase("und");
            const skeleton = canonical.replaceAll("а", "a").replaceAll("\u200b", "");
            return { canonical, certainty: canonical === skeleton ? "certain" : "uncertain",
              skeleton };
          } },
        } },
      );
      await expect(useCase.execute({
        authorizationPrincipalRef: "principal:v1:opaque",
        deliveryContainerId: "question-thread-1",
        finalProjectionReceipt: authority.finalProjectionReceipt,
        projectionTargetContainerId: authority.projectionTargetContainerId,
        questionHash: "c".repeat(64), questionId: "question-denied",
        questionText, requesterSubject: "d".repeat(64), schemaVersion: 2,
        scopeId: authority.scopeId,
      })).resolves.toEqual({ reason: "retrieval_filter_denied", status: "ignored" });
      expect(commit).not.toHaveBeenCalled();
    });
});
