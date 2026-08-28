import type { FocusedMemoryReference } from "../../domain/grounding-plan.js";
import { MeetingKnowledgeInvariantError, requireKnowledgeText, requireSha256 } from
  "../../domain/errors.js";
import type { RetrievalBindingSnapshot } from "../../domain/retrieval-admission.js";
import type { FocusedLocatorRetrievalV2Candidate } from
  "./focused-locator-retrieval-v2.js";

/** Binds decoded candidate accounting to the immutable question retrieval path. */
export function retrievalAuditsBindInput(
  candidates: readonly FocusedMemoryReference[],
  binding: RetrievalBindingSnapshot | undefined,
): boolean {
  if (binding?.retrievalPath !== "infinity_locator_v2") {
    return binding?.retrievalPath === "canonical_local_exact_lexical_v1" &&
      candidates.every(({ retrievalAudit, turnId }) => retrievalAudit !== undefined &&
        retrievalAudit.capabilityFingerprint === binding.profileFingerprint &&
        retrievalAudit.profileId === binding.retrievalPath &&
        retrievalAudit.locator === `canonical-turn:${turnId}`);
  }
  return candidates.every(({ historicalSource, retrievalAudit }) =>
    retrievalAudit !== undefined &&
    retrievalAudit.capabilityFingerprint === binding.request.binding.capabilityFingerprint &&
    retrievalAudit.profileId === binding.request.binding.profileId &&
    (historicalSource === undefined ||
      retrievalAudit.locator === historicalSource.candidateLocator));
}

export function decodeFocusedRetrievalAudit(
  value: unknown,
  field: string,
): FocusedMemoryReference["retrievalAudit"] {
  if (value === undefined) {return undefined;}
  const audit = decodedRecord(value, field, ["capabilityFingerprint", "contributions",
    "fusedScore", "locator", "profileId", "providerRank", "requestDigest",
    "responseDigest"]);
  if (!Array.isArray(audit.contributions) || audit.contributions.length < 1 ||
    audit.contributions.length > 32 || !finite(audit.fusedScore) ||
    !rank(audit.providerRank)) {invalid(field);}
  const contributions = audit.contributions.map((entry, index) => {
    const itemField = `${field}.contributions[${index}]`;
    const item = decodedRecord(entry, itemField, ["contributionScorePicos",
      "providerLaneId", "providerRank", "queryId", "rawScoreKind", "rawScoreValue"]);
    if (!safeInteger(item.contributionScorePicos) || !rank(item.providerRank) ||
      !scoreKind(item.rawScoreKind) || (item.rawScoreValue !== null &&
        !finite(item.rawScoreValue))) {invalid(itemField);}
    return Object.freeze({ contributionScorePicos: item.contributionScorePicos,
      providerLaneId: text(item.providerLaneId, `${itemField}.providerLaneId`, 128),
      providerRank: item.providerRank,
      queryId: text(item.queryId, `${itemField}.queryId`, 128),
      rawScoreKind: item.rawScoreKind, rawScoreValue: item.rawScoreValue });
  });
  return Object.freeze({ capabilityFingerprint: sha(audit.capabilityFingerprint,
    `${field}.capabilityFingerprint`), contributions: Object.freeze(contributions),
    fusedScore: audit.fusedScore, locator: text(audit.locator, `${field}.locator`, 1_024),
    profileId: text(audit.profileId, `${field}.profileId`, 256),
    providerRank: audit.providerRank, requestDigest: sha(audit.requestDigest,
      `${field}.requestDigest`), responseDigest: sha(audit.responseDigest,
      `${field}.responseDigest`) });
}

export function decodeFocusedLocatorCandidate(value: unknown):
FocusedLocatorRetrievalV2Candidate | null {
  try {
    const candidate = decodedRecord(value, "retrieval candidate",
      ["locator", "retrievalProvenance"]);
    const locator = text(candidate.locator, "retrieval candidate.locator", 1_024);
    const retrievalProvenance = decodeFocusedRetrievalAudit(
      candidate.retrievalProvenance, "retrieval candidate.retrievalProvenance",
    );
    return retrievalProvenance?.locator === locator
      ? Object.freeze({ locator, retrievalProvenance }) : null;
  } catch {return null;}
}

function decodedRecord(value: unknown, field: string, keys: readonly string[]):
Readonly<Record<string, unknown>> {
  if (!isUnknownRecord(value)) {invalid(field);}
  const actual = Object.keys(value).toSorted(), expected = [...keys].toSorted();
  if (actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])) {invalid(field);}
  return value;
}
function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
function invalid(field: string): never {
  throw new MeetingKnowledgeInvariantError("INVALID_GROUNDING_PLAN", `${field} is invalid`);
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function rank(value: unknown): value is number {return safeInteger(value) && value >= 1;}
function scoreKind(value: unknown): value is
NonNullable<FocusedMemoryReference["retrievalAudit"]>["contributions"][number]["rawScoreKind"] {
  return value === null || value === "bm25" || value === "distance" ||
    value === "relevance" || value === "similarity";
}
function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {invalid(field);}
  return requireKnowledgeText(value, field, maximum);
}
function sha(value: unknown, field: string): string {
  if (typeof value !== "string") {invalid(field);}
  return requireSha256(value, field);
}
