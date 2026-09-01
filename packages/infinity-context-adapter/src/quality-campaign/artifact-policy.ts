import { type AttemptIdentity, assertAttemptIdentity, attemptIdentity,
  type CallKind } from "./execution.js";

export type EncryptedArtifactKind = "adjudication_input" | "adjudicator_1_result" |
  "adjudicator_2_result" | "answer_request" | "answer_response" | "capability_request" |
  "capability_response" | "evidence" | "final_adjudication" | "raw_outcome" |
  "resolver_result" | "retrieval_request" | "retrieval_response";

export interface ArtifactReceipt {
  readonly aadSha256: string; readonly artifactBindingSha256: string;
  readonly artifactKind: EncryptedArtifactKind; readonly attemptId: string;
  readonly envelopeSha256: string; readonly keyId: string; readonly keyBindingSha256: string;
  readonly plaintextBytes: number; readonly plaintextSha256: string; readonly questionId: string;
  readonly repetition: 1 | 2 | 3; readonly storedBytes: number;
}

export interface ArtifactAad extends Omit<AttemptIdentity, "attemptId"> {
  readonly artifactKind: EncryptedArtifactKind; readonly attemptId: string;
  readonly keyId: string; readonly plaintextSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_artifact_aad.v3";
}

export const ARTIFACT_CALL_KIND = Object.freeze({
  adjudication_input: "adjudicator_1", adjudicator_1_result: "adjudicator_1",
  adjudicator_2_result: "adjudicator_2", answer_request: "answer", answer_response: "answer",
  capability_request: "capability", capability_response: "capability", evidence: "retrieval",
  final_adjudication: "answer", raw_outcome: "answer", resolver_result: "resolver",
  retrieval_request: "retrieval", retrieval_response: "retrieval",
} satisfies Readonly<Record<EncryptedArtifactKind, CallKind>>);

export function artifactAttemptIdentity(answerAttempt: AttemptIdentity,
  artifactKind: EncryptedArtifactKind): AttemptIdentity {
  assertAttemptIdentity(answerAttempt);
  if (answerAttempt.callKind !== "answer" || answerAttempt.callOrdinal !== 0) {
    throw new Error("artifact inventory requires the canonical answer attempt");
  }
  return attemptIdentity({ callKind: ARTIFACT_CALL_KIND[artifactKind], callOrdinal: 0,
    campaignRootSha256: answerAttempt.campaignRootSha256,
    questionDigestSha256: answerAttempt.questionDigestSha256,
    questionId: answerAttempt.questionId, releaseRootSha256: answerAttempt.releaseRootSha256,
    repetition: answerAttempt.repetition,
    spendReservationSha256: answerAttempt.spendReservationSha256 });
}

export function assertArtifactAttemptIdentity(artifactKind: EncryptedArtifactKind,
  identity: AttemptIdentity): void {
  assertAttemptIdentity(identity);
  if (identity.callKind !== ARTIFACT_CALL_KIND[artifactKind] || identity.callOrdinal !== 0) {
    throw new Error(`artifact ${artifactKind} has foreign call semantics`);
  }
}
