import { describe, expect, it } from "vitest";

import {
  QuestionBinding,
  focusedMemoryGeneration,
  type CanonicalFinalReplyEvidenceResult,
  type CurrentFinalReplyBinding,
  type CurrentFinalReplyBindingResult,
  type FinalReplyEvidencePort,
  type FocusedMemoryReference,
  type FocusedMemoryRetrievalPort,
  type FocusedMemoryRetrievalResult,
  type QuestionAuthorizationCheckpoint,
  type QuestionAuthorizationObservation,
  type QuestionAuthorizationPort,
  type QuestionBindingSnapshot,
  type RehydratedEvidenceTurn,
} from "@discord-meeting/meeting-core/meeting-knowledge";

export const authorizationPolicyVersion = "discord.participant-current-results.v1";

export const authority: CurrentFinalReplyBinding = {
  botApplicationIdentity: "botik-application-1",
  canonicalEvidenceHash: "b".repeat(64),
  finalProjectionEpoch: "meeting-summary-publication:v1:epoch",
  finalProjectionReceipt: "discord:v2:channel:33333333333333333:message:55555555555555555",
  humanActorIds: ["requester-actor", "speaker-b"],
  meetingId: "meeting-1",
  meetingRevision: 8,
  memoryGeneration: focusedMemoryGeneration("b".repeat(64)),
  projectionTargetContainerId: "33333333333333333",
  roomId: "voice-channel-1",
  scopeId: "guild-1",
  transcriptId: "transcript-1",
  transcriptVersion: 1,
};

export const selectedTurns: readonly RehydratedEvidenceTurn[] = Object.freeze([
  Object.freeze({
    endMs: 2_000,
    speakerId: "requester-actor",
    startMs: 0,
    text: "The release was initially planned for Friday.",
    turnHash: "1".repeat(64),
    turnId: "turn-initial",
  }),
  Object.freeze({
    endMs: 7_202_000,
    speakerId: "speaker-b",
    startMs: 7_200_000,
    text: "Correction: the release is Monday, not Friday.",
    turnHash: "2".repeat(64),
    turnId: "turn-correction",
  }),
]);

export const references: readonly FocusedMemoryReference[] = Object.freeze(
  selectedTurns.map(({ turnHash, turnId }) => Object.freeze({
    meetingId: authority.meetingId,
    retrievalAudit: retrievalAuditFor("infinity_locator_v2", turnId),
    transcriptId: authority.transcriptId,
    transcriptVersion: authority.transcriptVersion,
    turnHash,
    turnId,
  })),
);

function retrievalAuditFor(
  path: "canonical_local_exact_lexical_v1" | "infinity_locator_v2",
  turnId: string,
  locator = `canonical-turn:${turnId}`,
) {
  const local = path === "canonical_local_exact_lexical_v1";
  return Object.freeze({
    capabilityFingerprint: (local ? "f" : "e").repeat(64),
    contributions: Object.freeze([Object.freeze({
      contributionScorePicos: 1_000_000,
      providerLaneId: local ? "canonical_local_exact_lexical" : "postgres_keyword",
      providerRank: 1,
      queryId: "original-question",
      rawScoreKind: "bm25" as const,
      rawScoreValue: 1,
    })]),
    fusedScore: 1,
    locator,
    profileId: local ? path : "profile-v2",
    providerRank: 1,
    requestDigest: "8".repeat(64),
    responseDigest: "9".repeat(64),
  });
}

export const fixedReplyText = Object.freeze({
  insufficient_evidence: "There is not enough confirmed meeting evidence.",
  not_a_question: "This reply is not a question.",
  processing: "The meeting evidence is still being processed.",
  unavailable: "A grounded answer is currently unavailable.",
  unsupported_size: "This meeting is too large.",
});

function authorizationObservation(): Extract<
  QuestionAuthorizationObservation,
  { readonly status: "authorized" }
> {
  return {
    actorId: "requester-actor",
    containerId: authority.projectionTargetContainerId,
    deliveryContainerId: "question-thread-1",
    digest: "a".repeat(64),
    expiresAt: "2026-08-13T18:01:00.000Z",
    observedAt: "2026-08-13T18:00:00.000Z",
    policyVersion: authorizationPolicyVersion,
    scopeId: authority.scopeId,
    source: "authoritative_remote",
    status: "authorized",
  };
}

export class AuthorizationFake implements QuestionAuthorizationPort {
  public readonly checkpoints: QuestionAuthorizationCheckpoint[] = [];
  public denyAt?: QuestionAuthorizationCheckpoint;

  public observe(input: {
    readonly checkpoint: QuestionAuthorizationCheckpoint;
  }): Promise<QuestionAuthorizationObservation> {
    this.checkpoints.push(input.checkpoint);
    return Promise.resolve(this.denyAt === input.checkpoint
      ? { reason: "denied", status: "denied" }
      : authorizationObservation());
  }
}

export class EvidenceFake implements FinalReplyEvidencePort {
  public current: CurrentFinalReplyBinding | null = authority;
  public currentResult: CurrentFinalReplyBindingResult = {
    binding: authority,
    status: "current",
  };
  public hydrated: CanonicalFinalReplyEvidenceResult = {
    binding: authority,
    status: "current",
    turns: selectedTurns,
  };
  public readonly hydrationResults: CanonicalFinalReplyEvidenceResult[] = [];
  public readonly references: (readonly FocusedMemoryReference[])[] = [];
  public rechecks = 0;

  public findCurrentBinding(): Promise<CurrentFinalReplyBinding | null> {
    return Promise.resolve(this.current);
  }

  public recheckCurrentBinding(): Promise<CurrentFinalReplyBindingResult> {
    this.rechecks += 1;
    return Promise.resolve(this.currentResult);
  }

  public rehydrateSelectedEvidence(
    _binding: QuestionBindingSnapshot,
    input: readonly FocusedMemoryReference[],
  ): Promise<CanonicalFinalReplyEvidenceResult> {
    this.references.push(input);
    const result = this.hydrationResults.shift() ?? this.hydrated;
    if (result.status !== "current") {return Promise.resolve(result);}
    return Promise.resolve({ ...result, turns: result.turns.map((turn) => {
      const reference = input.find(({ turnId }) => turnId === turn.turnId);
      return reference?.retrievalAudit === undefined ? turn : Object.freeze({
        ...turn,
        retrievalAudit: reference.retrievalAudit,
      });
    }) });
  }
}

export class MemoryFake implements FocusedMemoryRetrievalPort {
  public readonly calls: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0][] = [];
  public historicalAuthorizationCalls = 0;
  public historicalAuthorizationResults: boolean[] = [];
  public result: FocusedMemoryRetrievalResult = {
    authorityGeneration: authority.memoryGeneration,
    candidates: references,
    schemaVersion: 1,
    status: "current",
  };

  public retrieve(input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0]) {
    this.calls.push(input);
    if (this.result.status !== "current") {return Promise.resolve(this.result);}
    const path = input.retrievalBinding?.retrievalPath;
    if (path !== "infinity_locator_v2" &&
      path !== "canonical_local_exact_lexical_v1") {
      return Promise.resolve(this.result);
    }
    return Promise.resolve({ ...this.result, candidates: this.result.candidates.map(
      (reference) => Object.freeze({
        ...reference,
        retrievalAudit: retrievalAuditFor(
          path,
          reference.turnId,
          reference.historicalSource?.candidateLocator,
        ),
      }),
    ) });
  }

  public reauthorizeHistoricalEvidence(): Promise<boolean> {
    this.historicalAuthorizationCalls += 1;
    return Promise.resolve(this.historicalAuthorizationResults.shift() ?? true);
  }
}

export function binding(): QuestionBindingSnapshot {
  return QuestionBinding.create({
    authorizationDigest: "a".repeat(64),
    authorizationPolicyVersion,
    authorizationPrincipalRef: "principal:v1:opaque",
    botApplicationIdentity: authority.botApplicationIdentity,
    canonicalEvidenceHash: authority.canonicalEvidenceHash,
    deliveryContainerId: "question-thread-1",
    expectedLocale: "en",
    finalProjectionEpoch: authority.finalProjectionEpoch,
    finalProjectionReceipt: authority.finalProjectionReceipt,
    humanActorIds: authority.humanActorIds,
    meetingId: authority.meetingId,
    meetingRevision: authority.meetingRevision,
    memoryGeneration: authority.memoryGeneration,
    policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
    projectionTargetContainerId: authority.projectionTargetContainerId,
    questionHash: "c".repeat(64),
    questionId: "question-1",
    requesterSubject: "d".repeat(64),
    roomId: authority.roomId,
    scopeId: authority.scopeId,
    transcriptId: authority.transcriptId,
    transcriptVersion: authority.transcriptVersion,
  }).toSnapshot();
}

describe("local final reply application fixtures", () => {
  it("keeps selected references bound to the authoritative transcript", () => {
    expect(references).toEqual(selectedTurns.map(({ turnHash, turnId }) => ({
      meetingId: authority.meetingId,
      retrievalAudit: retrievalAuditFor("infinity_locator_v2", turnId),
      transcriptId: authority.transcriptId,
      transcriptVersion: authority.transcriptVersion,
      turnHash,
      turnId,
    })));
    expect(binding()).toMatchObject({
      authorizationPolicyVersion,
      memoryGeneration: authority.memoryGeneration,
    });
  });
});
