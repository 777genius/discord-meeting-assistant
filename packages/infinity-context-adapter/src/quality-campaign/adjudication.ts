import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { assertAttemptIdentity, type AttemptIdentity, type SignedValue,
  verifyExternalSignedValue } from "./execution.js";
import { type QualityAuthorityRole, QualityCampaignAuthorityPolicy } from "./release.js";

export interface CanonicalClaimDecision {
  readonly abstentionCorrect: boolean;
  readonly citationEntailed: boolean;
  readonly claimFactual: boolean;
  readonly claimId: string;
  readonly claimSupported: boolean;
  readonly matchedGoldClaimId: string | null;
}

export interface CanonicalAdjudicationDecision {
  readonly answerComplete: boolean;
  readonly claims: readonly CanonicalClaimDecision[];
  readonly outcomeDigestSha256: string;
  readonly questionId: string;
}

export interface DecisionReceiptPayload {
  readonly attemptId: string;
  readonly decision: CanonicalAdjudicationDecision;
  readonly decisionDigestSha256: string;
  readonly encryptedEvidenceSha256: string;
  readonly firstDecisionDigestSha256: string | null;
  readonly outcomeDigestSha256: string;
  readonly questionId: string;
  readonly resolverBindingSha256: string | null;
  readonly secondDecisionDigestSha256: string | null;
}

export type DecisionReceipt = SignedValue<DecisionReceiptPayload>;

export interface AdjudicationRequest {
  readonly attemptId: string;
  readonly encryptedEvidenceSha256: string;
  readonly firstDecisionDigestSha256: string | null;
  readonly firstDecisionReceipt: DecisionReceipt | null;
  readonly outcomeDigestSha256: string;
  readonly questionId: string;
  readonly resolverBindingSha256: string | null;
  readonly secondDecisionDigestSha256: string | null;
  readonly secondDecisionReceipt: DecisionReceipt | null;
}

export interface RawOutcomeVaultPort {
  /** Implementations decrypt inside the private runner; plaintext must never cross logs/status. */
  reconstruct(input: { readonly attempt: AttemptIdentity; readonly envelopeSha256: string }):
  Promise<{ readonly encryptedEvidenceSha256: string; readonly outcomeDigestSha256: string }>;
}

export interface FinalAdjudicationEnvelope {
  readonly attempt: AttemptIdentity;
  readonly decision: CanonicalAdjudicationDecision;
  readonly decisionDigestSha256: string;
  readonly encryptedEvidenceSha256: string;
  readonly firstReceipt: DecisionReceipt;
  readonly outcomeDigestSha256: string;
  readonly resolverReceipt: DecisionReceipt | null;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_final_adjudication.v2";
  readonly secondReceipt: DecisionReceipt;
}

export interface ExpectedAdjudicationAttempt {
  readonly campaignRootSha256: string;
  readonly questionDigestSha256: string;
  readonly questionId: string;
  readonly releaseRootSha256: string;
  readonly repetition: 1 | 2 | 3;
  readonly spendReservationSha256: string;
}

/** Verifies already-executed reviewer evidence; provider effects use the durable exchange boundary. */
export async function adjudicateOutcome(policy: QualityCampaignAuthorityPolicy,
  input: { readonly attempt: AttemptIdentity;
  readonly expectedAttempt: ExpectedAdjudicationAttempt;
  readonly firstReceipt: unknown; readonly rawOutcomeEnvelopeSha256: string;
  readonly resolverReceipt: unknown; readonly secondReceipt: unknown;
  readonly vault: RawOutcomeVaultPort }): Promise<FinalAdjudicationEnvelope> {
  assertAdjudicationAttempt(input.attempt, input.expectedAttempt);
  verifyReceiptAuthority(policy, "reviewer_1", input.firstReceipt);
  verifyReceiptAuthority(policy, "reviewer_2", input.secondReceipt);
  if (input.resolverReceipt !== null) {
    verifyReceiptAuthority(policy, "resolver", input.resolverReceipt);
  }
  const raw = await input.vault.reconstruct({ attempt: input.attempt,
    envelopeSha256: digest(input.rawOutcomeEnvelopeSha256, "raw outcome envelope") });
  const request = { attemptId: input.attempt.attemptId,
    encryptedEvidenceSha256: digest(raw.encryptedEvidenceSha256, "encrypted evidence"),
    firstDecisionDigestSha256: null, firstDecisionReceipt: null,
    outcomeDigestSha256: digest(raw.outcomeDigestSha256, "raw outcome"),
    questionId: input.attempt.questionId, resolverBindingSha256: null,
    secondDecisionDigestSha256: null, secondDecisionReceipt: null };
  const first = verifyDecisionReceipt(policy, "reviewer_1", input.firstReceipt, request);
  const second = verifyDecisionReceipt(policy, "reviewer_2", input.secondReceipt, request);
  let decision = first.payload.decision;
  let resolverReceipt: DecisionReceipt | null = null;
  if (first.payload.decisionDigestSha256 !== second.payload.decisionDigestSha256) {
    verifyDecisionReceipt(policy, "reviewer_1", first, request);
    verifyDecisionReceipt(policy, "reviewer_2", second, request);
    const resolverBindingSha256 = sha256({ attemptId: request.attemptId,
      encryptedEvidenceSha256: request.encryptedEvidenceSha256,
      firstDecisionReceipt: first, outcomeDigestSha256: request.outcomeDigestSha256,
      questionId: request.questionId,
      schemaVersion: "meeting_knowledge.semantic_quality_resolver_binding.v1",
      secondDecisionReceipt: second });
    const resolverRequest = { ...request,
      firstDecisionDigestSha256: first.payload.decisionDigestSha256,
      firstDecisionReceipt: first, resolverBindingSha256,
      secondDecisionDigestSha256: second.payload.decisionDigestSha256,
      secondDecisionReceipt: second };
    if (input.resolverReceipt === null) {throw new Error("conflicting reviews lack resolver evidence");}
    const resolver = verifyDecisionReceipt(policy, "resolver", input.resolverReceipt,
      resolverRequest);
    decision = resolver.payload.decision;
    resolverReceipt = resolver;
  } else if (input.resolverReceipt !== null) {throw new Error("resolver evidence is orphaned");}
  return Object.freeze({ attempt: input.attempt, decision, decisionDigestSha256: sha256(decision),
    encryptedEvidenceSha256: raw.encryptedEvidenceSha256, firstReceipt: first,
    outcomeDigestSha256: raw.outcomeDigestSha256, resolverReceipt,
    schemaVersion: "meeting_knowledge.semantic_quality_final_adjudication.v2", secondReceipt: second });
}

export function verifyRetainedFinalAdjudication(policy: QualityCampaignAuthorityPolicy,
  value: unknown, expectedAttempt: AttemptIdentity, resolverRequired: boolean):
FinalAdjudicationEnvelope {
  const record = exactRecord(value, ["attempt", "decision", "decisionDigestSha256",
    "encryptedEvidenceSha256", "firstReceipt", "outcomeDigestSha256", "resolverReceipt",
    "schemaVersion", "secondReceipt"], "retained final adjudication");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_final_adjudication.v2" ||
    typeof resolverRequired !== "boolean") {throw new Error("final adjudication schema is invalid");}
  const attempt = record.attempt as AttemptIdentity;
  assertAttemptIdentity(attempt);
  if (canonicalJson(attempt) !== canonicalJson(expectedAttempt)) {
    throw new Error("final adjudication attempt is foreign");
  }
  const encryptedEvidenceSha256 = digest(record.encryptedEvidenceSha256,
    "final adjudication encrypted evidence");
  const outcomeDigestSha256 = digest(record.outcomeDigestSha256,
    "final adjudication outcome");
  const baseRequest: AdjudicationRequest = { attemptId: attempt.attemptId,
    encryptedEvidenceSha256, firstDecisionDigestSha256: null, firstDecisionReceipt: null,
    outcomeDigestSha256, questionId: attempt.questionId, resolverBindingSha256: null,
    secondDecisionDigestSha256: null, secondDecisionReceipt: null };
  const first = verifyDecisionReceipt(policy, "reviewer_1", record.firstReceipt,
    baseRequest);
  const second = verifyDecisionReceipt(policy, "reviewer_2", record.secondReceipt,
    baseRequest);
  const disagrees = first.payload.decisionDigestSha256 !== second.payload.decisionDigestSha256;
  let selected = first.payload.decision; let resolverReceipt: DecisionReceipt | null = null;
  if (disagrees) {
    if (record.resolverReceipt === null) {throw new Error("conflict lacks a complete resolver receipt");}
    const resolverBindingSha256 = sha256({ attemptId: baseRequest.attemptId,
      encryptedEvidenceSha256, firstDecisionReceipt: first, outcomeDigestSha256,
      questionId: baseRequest.questionId,
      schemaVersion: "meeting_knowledge.semantic_quality_resolver_binding.v1",
      secondDecisionReceipt: second });
    const resolverRequest = { ...baseRequest,
      firstDecisionDigestSha256: first.payload.decisionDigestSha256,
      firstDecisionReceipt: first, resolverBindingSha256,
      secondDecisionDigestSha256: second.payload.decisionDigestSha256,
      secondDecisionReceipt: second };
    resolverReceipt = verifyDecisionReceipt(policy, "resolver", record.resolverReceipt,
      resolverRequest);
    selected = resolverReceipt.payload.decision;
  } else if (record.resolverReceipt !== null) {
    throw new Error("unconflicted adjudication contains an orphan resolver receipt");
  }
  const decision = decodeDecision(record.decision);
  if (resolverRequired !== disagrees || canonicalJson(decision) !== canonicalJson(selected) ||
    record.decisionDigestSha256 !== sha256(decision)) {
    throw new Error("final adjudication does not bind its complete signed decisions");
  }
  return Object.freeze({ attempt, decision, decisionDigestSha256: record.decisionDigestSha256,
    encryptedEvidenceSha256, firstReceipt: first, outcomeDigestSha256, resolverReceipt,
    schemaVersion: "meeting_knowledge.semantic_quality_final_adjudication.v2",
    secondReceipt: second });
}

function assertAdjudicationAttempt(attempt: AttemptIdentity,
  expected: ExpectedAdjudicationAttempt): void {
  exactRecord(expected, ["campaignRootSha256", "questionDigestSha256", "questionId",
    "releaseRootSha256", "repetition", "spendReservationSha256"],
  "expected adjudication attempt");
  assertAttemptIdentity(attempt, expected);
  digest(expected.questionDigestSha256, "expected adjudication question digest");
  safeId(expected.questionId, "expected adjudication question ID");
  if (attempt.callKind !== "answer" || attempt.callOrdinal !== 0 ||
    attempt.questionDigestSha256 !== expected.questionDigestSha256 ||
    attempt.questionId !== expected.questionId || attempt.repetition !== expected.repetition) {
    throw new Error("adjudication attempt has foreign identity or call semantics");
  }
}

function verifyDecisionReceipt(policy: QualityCampaignAuthorityPolicy,
  role: Extract<QualityAuthorityRole, "reviewer_1" | "reviewer_2" | "resolver">,
  value: unknown, request: AdjudicationRequest): DecisionReceipt {
  const pin = policy.authority(role);
  const receipt = verifyExternalSignedValue<DecisionReceiptPayload>(value,
      pin.keyId, pin.publicKeyPem,
      "adjudication receipt");
  const payload = exactRecord(receipt.payload, ["attemptId", "decision",
    "decisionDigestSha256", "encryptedEvidenceSha256", "firstDecisionDigestSha256",
    "outcomeDigestSha256", "questionId", "resolverBindingSha256",
    "secondDecisionDigestSha256"],
  "adjudication result");
  const decision = decodeDecision(payload.decision);
  if (payload.attemptId !== request.attemptId ||
    payload.encryptedEvidenceSha256 !== request.encryptedEvidenceSha256 ||
    payload.firstDecisionDigestSha256 !== request.firstDecisionDigestSha256 ||
    payload.outcomeDigestSha256 !== request.outcomeDigestSha256 ||
    payload.questionId !== request.questionId ||
    payload.resolverBindingSha256 !== request.resolverBindingSha256 ||
    payload.secondDecisionDigestSha256 !== request.secondDecisionDigestSha256 ||
    decision.questionId !== request.questionId ||
    decision.outcomeDigestSha256 !== request.outcomeDigestSha256 ||
    payload.decisionDigestSha256 !== sha256(decision)) {
    throw new Error("adjudication result does not reconstruct from exact raw evidence");
  }
  return receipt;
}

function verifyReceiptAuthority(policy: QualityCampaignAuthorityPolicy,
  role: Extract<QualityAuthorityRole, "reviewer_1" | "reviewer_2" | "resolver">,
  value: unknown): void {
  const pin = policy.authority(role);
  verifyExternalSignedValue(value, pin.keyId, pin.publicKeyPem, "adjudication receipt");
}

function decodeDecision(value: unknown): CanonicalAdjudicationDecision {
  const record = exactRecord(value, ["answerComplete", "claims", "outcomeDigestSha256",
    "questionId"], "adjudication decision");
  if (typeof record.answerComplete !== "boolean" || !Array.isArray(record.claims)) {
    throw new Error("adjudication decision is invalid");
  }
  safeId(record.questionId, "adjudicated question ID");
  digest(record.outcomeDigestSha256, "adjudicated outcome");
  const claims = record.claims.map((claim) => {
    const item = exactRecord(claim, ["abstentionCorrect", "citationEntailed", "claimFactual",
      "claimId", "claimSupported", "matchedGoldClaimId"], "claim decision");
    if (![item.abstentionCorrect, item.citationEntailed, item.claimFactual,
      item.claimSupported].every((field) => typeof field === "boolean") ||
      item.matchedGoldClaimId !== null && typeof item.matchedGoldClaimId !== "string") {
      throw new Error("claim decision is invalid");
    }
    safeId(item.claimId, "claim ID");
    return item as unknown as CanonicalClaimDecision;
  });
  if (new Set(claims.map(({ claimId }) => claimId)).size !== claims.length) {
    throw new Error("claim adjudication membership is duplicated");
  }
  return Object.freeze({ answerComplete: record.answerComplete, claims: Object.freeze(claims),
    outcomeDigestSha256: String(record.outcomeDigestSha256), questionId: String(record.questionId) });
}
