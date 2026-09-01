import { createHash } from "node:crypto";

export interface QuestionReconciliationFixtureRow {
  readonly binding: unknown;
  readonly bindingHash: string;
  readonly groundingPlan: unknown;
  readonly questionId: string;
  readonly state: "queued" | "terminal";
}

export interface SerializedQuestionReconciliationFixtureRow {
  readonly binding: unknown;
  readonly binding_hash: string;
  readonly grounding_plan: unknown;
  readonly question_id: string;
  readonly state: "queued" | "terminal";
}

/** Match jsonb_to_recordset's SQL column contract explicitly at the fixture edge. */
export function serializeQuestionReconciliationFixtureRows(
  rows: readonly QuestionReconciliationFixtureRow[],
): readonly SerializedQuestionReconciliationFixtureRow[] {
  return Object.freeze(rows.map((row) => Object.freeze({
    binding: row.binding,
    binding_hash: row.bindingHash,
    grounding_plan: row.groundingPlan,
    question_id: row.questionId,
    state: row.state,
  })));
}

/** Exact JSON bytes emitted by the pre-composite protocol-2 codec. */
export const preCompositeProtocol2BindingJson =
  '{"authorizationDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","authorizationPolicyVersion":"discord.participant-current-results.v2","authorizationPrincipalRef":"principal:v1:pre-composite","botApplicationIdentity":"11111111111111111","bindingProtocolVersion":2,"canonicalEvidenceHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","deliveryContainerId":"22222222222222222","expectedLocale":"en","finalProjectionEpoch":"projection-epoch-r1","finalProjectionReceipt":"discord:v2:channel:22222222222222222:message:44444444444444444","humanActorIds":["77777777777777777"],"meetingId":"meeting-pre-composite","meetingRevision":1,"memoryGeneration":"focused-memory:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyVersion":"meeting-knowledge.focused-memory-final-reply.v3","projectionTargetContainerId":"22222222222222222","questionHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","questionId":"33333333333333333","requesterSubject":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","retrievalBinding":{"cutoverEpoch":"retrieval-v2-r1","profileFingerprint":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","retrievalPath":"canonical_local_exact_lexical_v1"},"roomId":"room-pre-composite","scopeId":"66666666666666666","transcriptId":"transcript-pre-composite","transcriptVersion":1}';

/** Deleted audit shape: capabilityFingerprint/profileId precede laneIdentity. */
export const preCompositeProtocol2GroundingPlanJson =
  '{"authorityGeneration":"focused-memory:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","evidence":[{"endMs":2000,"evidenceId":"turn-pre-composite","retrievalAudit":{"capabilityFingerprint":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","contributions":[{"contributionScorePicos":1000000,"providerLaneId":"canonical_local_exact_lexical","providerRank":1,"queryId":"original-question","rawScoreKind":"bm25","rawScoreValue":1}],"fusedScore":1,"locator":"canonical-turn:turn-pre-composite","profileId":"canonical_local_exact_lexical_v1","providerRank":1,"requestDigest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","responseDigest":"9999999999999999999999999999999999999999999999999999999999999999"},"speakerId":"77777777777777777","startMs":1000,"text":"Persisted authoritative words.","turnHash":"8888888888888888888888888888888888888888888888888888888888888888","turnId":"turn-pre-composite"}],"mode":"focused_retrieval"}';

export function exactPreCompositeFixture() {
  const binding = JSON.parse(preCompositeProtocol2BindingJson) as Record<string, unknown>;
  const { authorizationPrincipalRef: _principal, ...dedupe } = binding;
  return Object.freeze({
    binding,
    bindingHash: canonicalFixtureHash(dedupe),
    groundingPlan: JSON.parse(preCompositeProtocol2GroundingPlanJson) as unknown,
  });
}

/** Hash emitted before canonical key sorting, reconstructed in old snapshot order. */
export function preCanonicalPreCompositeBindingHash(): string {
  const binding = JSON.parse(preCompositeProtocol2BindingJson) as
    Record<string, unknown>;
  const ordered = {
    authorizationDigest: binding.authorizationDigest,
    authorizationPolicyVersion: binding.authorizationPolicyVersion,
    botApplicationIdentity: binding.botApplicationIdentity,
    canonicalEvidenceHash: binding.canonicalEvidenceHash,
    deliveryContainerId: binding.deliveryContainerId,
    expectedLocale: binding.expectedLocale,
    finalProjectionEpoch: binding.finalProjectionEpoch,
    finalProjectionReceipt: binding.finalProjectionReceipt,
    humanActorIds: binding.humanActorIds,
    meetingId: binding.meetingId,
    meetingRevision: binding.meetingRevision,
    memoryGeneration: binding.memoryGeneration,
    policyVersion: binding.policyVersion,
    projectionTargetContainerId: binding.projectionTargetContainerId,
    questionHash: binding.questionHash,
    questionId: binding.questionId,
    requesterSubject: binding.requesterSubject,
    roomId: binding.roomId,
    scopeId: binding.scopeId,
    transcriptId: binding.transcriptId,
    transcriptVersion: binding.transcriptVersion,
    bindingProtocolVersion: 2,
    retrievalBinding: { cutoverEpoch: "retrieval-v2-r1",
      profileFingerprint: "e".repeat(64),
      retrievalPath: "canonical_local_exact_lexical_v1" },
  };
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

export function canonicalFixtureHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonical);}
  if (typeof value !== "object" || value === null) {return value;}
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0).map(([key, nested]) =>
      [key, canonical(nested)]));
}
