import { digest, exactRecord, publicKeyFingerprintSha256, safeId, sha256 } from "./canonical.js";
import { type AttemptIdentity, type SignedValue, verifyExternalSignedValue } from "./execution.js";

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

export interface AdjudicationAuthorityPort {
  readonly authorityId: string;
  readonly publicKeyPem: string;
  readonly signerKeyId: string;
  adjudicate(input: { readonly attemptId: string; readonly encryptedEvidenceSha256: string;
    readonly firstDecisionDigestSha256: string | null; readonly outcomeDigestSha256: string;
    readonly questionId: string; readonly secondDecisionDigestSha256: string | null }):
  Promise<unknown>;
}

export interface RawOutcomeVaultPort {
  /** Implementations decrypt inside the private runner; plaintext must never cross logs/status. */
  reconstruct(input: { readonly attempt: AttemptIdentity; readonly envelopeSha256: string }):
  Promise<{ readonly encryptedEvidenceSha256: string; readonly outcomeDigestSha256: string }>;
}

export interface FinalAdjudicationEnvelope {
  readonly decision: CanonicalAdjudicationDecision;
  readonly decisionDigestSha256: string;
  readonly firstReceiptSha256: string;
  readonly outcomeDigestSha256: string;
  readonly resolverReceiptSha256: string | null;
  readonly secondReceiptSha256: string;
}

/** Calls two authorities always and the independent resolver only on canonical disagreement. */
export async function adjudicateOutcome(input: { readonly attempt: AttemptIdentity;
  readonly first: AdjudicationAuthorityPort; readonly rawOutcomeEnvelopeSha256: string;
  readonly resolver: AdjudicationAuthorityPort; readonly second: AdjudicationAuthorityPort;
  readonly vault: RawOutcomeVaultPort }): Promise<FinalAdjudicationEnvelope> {
  assertIndependentAuthorities([input.first, input.second, input.resolver]);
  const raw = await input.vault.reconstruct({ attempt: input.attempt,
    envelopeSha256: digest(input.rawOutcomeEnvelopeSha256, "raw outcome envelope") });
  const request = { attemptId: input.attempt.attemptId,
    encryptedEvidenceSha256: digest(raw.encryptedEvidenceSha256, "encrypted evidence"),
    firstDecisionDigestSha256: null,
    outcomeDigestSha256: digest(raw.outcomeDigestSha256, "raw outcome"),
    questionId: input.attempt.questionId, secondDecisionDigestSha256: null };
  const [firstRaw, secondRaw] = await Promise.all([
    input.first.adjudicate(request), input.second.adjudicate(request),
  ]);
  const first = verifyDecisionReceipt(firstRaw, input.first, request);
  const second = verifyDecisionReceipt(secondRaw, input.second, request);
  let decision = first.payload.decision;
  let resolverReceiptSha256: string | null = null;
  if (first.payload.decisionDigestSha256 !== second.payload.decisionDigestSha256) {
    const resolverRequest = { ...request,
      firstDecisionDigestSha256: first.payload.decisionDigestSha256,
      secondDecisionDigestSha256: second.payload.decisionDigestSha256 };
    const resolverRaw = await input.resolver.adjudicate(resolverRequest);
    const resolver = verifyDecisionReceipt(resolverRaw, input.resolver, resolverRequest);
    decision = resolver.payload.decision;
    resolverReceiptSha256 = sha256(resolver);
  }
  return Object.freeze({ decision, decisionDigestSha256: sha256(decision),
    firstReceiptSha256: sha256(first), outcomeDigestSha256: raw.outcomeDigestSha256,
    resolverReceiptSha256, secondReceiptSha256: sha256(second) });
}

function verifyDecisionReceipt(value: unknown, authority: AdjudicationAuthorityPort,
  request: { readonly attemptId: string; readonly encryptedEvidenceSha256: string;
    readonly firstDecisionDigestSha256: string | null; readonly outcomeDigestSha256: string;
    readonly questionId: string; readonly secondDecisionDigestSha256: string | null }): SignedValue<{
      readonly attemptId: string; readonly decision: CanonicalAdjudicationDecision;
      readonly decisionDigestSha256: string; readonly encryptedEvidenceSha256: string;
      readonly firstDecisionDigestSha256: string | null; readonly outcomeDigestSha256: string;
      readonly questionId: string; readonly secondDecisionDigestSha256: string | null }> {
  const receipt = verifyExternalSignedValue<{
    readonly attemptId: string; readonly decision: CanonicalAdjudicationDecision;
    readonly decisionDigestSha256: string; readonly encryptedEvidenceSha256: string;
    readonly firstDecisionDigestSha256: string | null; readonly outcomeDigestSha256: string;
    readonly questionId: string; readonly secondDecisionDigestSha256: string | null }>(value,
      authority.signerKeyId, authority.publicKeyPem,
      "adjudication receipt");
  const payload = exactRecord(receipt.payload, ["attemptId", "decision",
    "decisionDigestSha256", "encryptedEvidenceSha256", "firstDecisionDigestSha256",
    "outcomeDigestSha256", "questionId", "secondDecisionDigestSha256"],
  "adjudication result");
  const decision = decodeDecision(payload.decision);
  if (payload.attemptId !== request.attemptId ||
    payload.encryptedEvidenceSha256 !== request.encryptedEvidenceSha256 ||
    payload.firstDecisionDigestSha256 !== request.firstDecisionDigestSha256 ||
    payload.outcomeDigestSha256 !== request.outcomeDigestSha256 ||
    payload.questionId !== request.questionId ||
    payload.secondDecisionDigestSha256 !== request.secondDecisionDigestSha256 ||
    decision.questionId !== request.questionId ||
    decision.outcomeDigestSha256 !== request.outcomeDigestSha256 ||
    payload.decisionDigestSha256 !== sha256(decision)) {
    throw new Error("adjudication result does not reconstruct from exact raw evidence");
  }
  return receipt;
}

function assertIndependentAuthorities(authorities: readonly AdjudicationAuthorityPort[]): void {
  const authorityIds = authorities.map(({ authorityId }) => safeId(authorityId, "authority ID"));
  const signerKeyIds = authorities.map(({ signerKeyId }) => safeId(signerKeyId, "signer key ID"));
  const fingerprints = authorities.map(({ publicKeyPem }, index) =>
    publicKeyFingerprintSha256(publicKeyPem, `authority ${index + 1}`));
  if (new Set(authorityIds).size !== authorities.length ||
    new Set(signerKeyIds).size !== authorities.length ||
    new Set(fingerprints).size !== authorities.length) {
    throw new Error("adjudication authorities are not cryptographically independent");
  }
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
