import type { FocusedMemoryReference } from "../../domain/grounding-plan.js";
import { MeetingKnowledgeInvariantError, requireKnowledgeText, requireSha256 } from
  "../../domain/errors.js";
import type { LocalCurrentRetrievalIdentitySnapshot,
  RetrievalBindingSnapshot } from "../../domain/retrieval-admission.js";
import type { FocusedLocatorRetrievalV2Candidate } from
  "./focused-locator-retrieval-v2.js";

/**
 * Canonical verifier shared by same-run retrieval, canonical hydration and the
 * persistence fence. It recomputes both digests and all lane/query accounting.
 */
export async function retrievalAuditsBindInput(
  candidates: readonly FocusedMemoryReference[],
  binding: RetrievalBindingSnapshot | undefined,
  exactQuestion?: string,
): Promise<boolean> {
  return retrievalAuditsBind(candidates, binding, exactQuestion, true);
}

/**
 * Grounding-plan construction canonicalizes evidence by source and transcript
 * position, so its durable order is intentionally different from the raw
 * composite retrieval interleave. The per-candidate request/result and lane
 * checks remain identical; only the already-consumed transport order is not
 * re-applied at the persistence and resume fences.
 */
export async function groundingPlanRetrievalAuditsBindInput(
  candidates: readonly FocusedMemoryReference[],
  binding: RetrievalBindingSnapshot | undefined,
  exactQuestion?: string,
): Promise<boolean> {
  return retrievalAuditsBind(candidates, binding, exactQuestion, false);
}

async function retrievalAuditsBind(
  candidates: readonly FocusedMemoryReference[],
  binding: RetrievalBindingSnapshot | undefined,
  exactQuestion: string | undefined,
  requireRetrievalOrder: boolean,
): Promise<boolean> {
  if (binding === undefined || candidates.length < 1 ||
    binding.canonicalEvidenceFilters === undefined ||
    binding.localCurrentIdentity === undefined ||
    binding.originalQuestion === undefined ||
    (exactQuestion !== undefined && binding.originalQuestion !== exactQuestion) ||
    candidates.some(({ retrievalAudit }) => retrievalAudit?.laneIdentity === undefined)) {
    return false;
  }
  const localRequestDigest = await canonicalDigest({
    hardFilters: binding.canonicalEvidenceFilters,
    laneIdentity: binding.localCurrentIdentity,
    originalQuestion: binding.originalQuestion,
    schemaVersion: 1,
  });
  const historicalRequestDigest = binding.retrievalPath === "infinity_locator_v2"
    ? await canonicalDigest(binding.request) : null;
  const queryIds = new Set(binding.retrievalPath === "infinity_locator_v2"
    ? binding.request.queries.map(({ queryId }) => queryId) : []);
  const providerLanes = new Set(binding.retrievalPath === "infinity_locator_v2"
    ? binding.request.binding.requiredProviderLanes : []);
  for (const candidate of candidates) {
    if (!await candidateAuditBinds(candidate, binding, localRequestDigest, {
      historicalRequestDigest, providerLanes, queryIds,
    })) {
      return false;
    }
  }
  return !requireRetrievalOrder ||
    laneOrderIsCanonical(candidates, binding.retrievalPath === "infinity_locator_v2");
}

async function candidateAuditBinds(
  candidate: FocusedMemoryReference,
  binding: RetrievalBindingSnapshot,
  localRequestDigest: string,
  historical: { readonly historicalRequestDigest: string | null;
    readonly providerLanes: ReadonlySet<string>; readonly queryIds: ReadonlySet<string> },
): Promise<boolean> {
  const audit = candidate.retrievalAudit;
  if (audit === undefined ||
    audit.locator !== (candidate.historicalSource?.candidateLocator ??
      `canonical-turn:${candidate.turnId}`) ||
    audit.responseDigest !== await canonicalDigest(canonicalResult(audit))) {
    return false;
  }
  return candidate.historicalSource === undefined
    ? localAuditBinds(audit, binding.localCurrentIdentity!, localRequestDigest)
    : historicalAuditBinds(audit, binding, historical.historicalRequestDigest,
        historical.queryIds, historical.providerLanes);
}

function localAuditBinds(
  audit: NonNullable<FocusedMemoryReference["retrievalAudit"]>,
  identity: LocalCurrentRetrievalIdentitySnapshot,
  requestDigest: string,
): boolean {
  const laneIdentity = audit.laneIdentity;
  if (laneIdentity === undefined) {return false;}
  return laneIdentity.lane === "local_current" &&
    sameLocalIdentity(laneIdentity, identity) &&
    audit.requestDigest === requestDigest && audit.contributions.length === 1 &&
    audit.contributions[0]?.providerLaneId === "canonical_local_exact_lexical" &&
    audit.contributions[0].queryId === "original-question" &&
    audit.contributions[0].providerRank === audit.providerRank;
}

function historicalAuditBinds(
  audit: NonNullable<FocusedMemoryReference["retrievalAudit"]>,
  binding: RetrievalBindingSnapshot,
  requestDigest: string | null,
  queryIds: ReadonlySet<string>,
  providerLanes: ReadonlySet<string>,
): boolean {
  return binding.retrievalPath === "infinity_locator_v2" &&
    audit.laneIdentity?.lane === "historical" &&
    audit.laneIdentity.capabilityFingerprint ===
      binding.request.binding.capabilityFingerprint &&
    audit.laneIdentity.profileId === binding.request.binding.profileId &&
    audit.requestDigest === requestDigest &&
    audit.contributions.every(({ providerLaneId, queryId }) =>
      providerLanes.has(providerLaneId) && queryIds.has(queryId));
}

export async function historicalRetrievalAuditsBindRequest(
  candidates: readonly {
    readonly locator: string;
    readonly retrievalProvenance: NonNullable<FocusedMemoryReference[
      "retrievalAudit"
    ]>;
  }[],
  request: Extract<RetrievalBindingSnapshot,
    { readonly retrievalPath: "infinity_locator_v2" }>["request"],
): Promise<boolean> {
  if (candidates.length < 1) {return false;}
  const requestDigest = await canonicalDigest(request);
  const queryIds = new Set(request.queries.map(({ queryId }) => queryId));
  const providerLanes = new Set(request.binding.requiredProviderLanes);
  return candidates.every(({ locator, retrievalProvenance: audit }, index) =>
    audit.laneIdentity?.lane === "historical" && audit.locator === locator &&
    audit.laneIdentity.capabilityFingerprint ===
      request.binding.capabilityFingerprint &&
    audit.laneIdentity.profileId === request.binding.profileId &&
    audit.requestDigest === requestDigest &&
    (index === 0 || audit.providerRank >
      candidates[index - 1]!.retrievalProvenance.providerRank) &&
    audit.contributions.every(({ providerLaneId, queryId }) =>
      providerLanes.has(providerLaneId) && queryIds.has(queryId))
  ) && (await Promise.all(candidates.map(async ({ retrievalProvenance: audit }) =>
    audit.responseDigest === await canonicalDigest(canonicalResult(audit))
  ))).every(Boolean);
}

export function decodeFocusedRetrievalAudit(
  value: unknown,
  field: string,
): FocusedMemoryReference["retrievalAudit"] {
  if (value === undefined) {return undefined;}
  const audit = decodedRecord(value, field, ["contributions", "fusedScore",
    "laneIdentity", "locator", "providerRank", "requestDigest",
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
  return Object.freeze({ contributions: Object.freeze(contributions),
    fusedScore: audit.fusedScore,
    laneIdentity: decodeLaneIdentity(audit.laneIdentity, `${field}.laneIdentity`),
    locator: text(audit.locator, `${field}.locator`, 1_024),
    providerRank: audit.providerRank, requestDigest: sha(audit.requestDigest,
      `${field}.requestDigest`), responseDigest: sha(audit.responseDigest,
      `${field}.responseDigest`) });
}

function decodeLaneIdentity(
  value: unknown,
  field: string,
): NonNullable<NonNullable<FocusedMemoryReference["retrievalAudit"]>["laneIdentity"]> {
  if (isUnknownRecord(value) && value.lane === "local_current") {
    const identity = decodedRecord(value, field,
      ["algorithmId", "lane", "profileFingerprint", "profileId"]);
    if (identity.algorithmId !== "canonical_local_exact_lexical_v1" ||
      identity.profileId !== "meeting-knowledge.local-current.v2") {invalid(field);}
    return Object.freeze({ algorithmId: identity.algorithmId,
      lane: "local_current", profileFingerprint: sha(identity.profileFingerprint,
        `${field}.profileFingerprint`), profileId: identity.profileId });
  }
  const identity = decodedRecord(value, field,
    ["capabilityFingerprint", "lane", "profileId"]);
  if (identity.lane !== "historical") {invalid(field);}
  return Object.freeze({ capabilityFingerprint: sha(identity.capabilityFingerprint,
    `${field}.capabilityFingerprint`), lane: "historical",
    profileId: text(identity.profileId, `${field}.profileId`, 256) });
}

function canonicalResult(
  audit: NonNullable<FocusedMemoryReference["retrievalAudit"]>,
): unknown {
  return {
    contributions: audit.contributions.map((contribution) => ({ ...contribution })),
    fusedScore: audit.fusedScore,
    locator: audit.locator,
    providerRank: audit.providerRank,
  };
}

function sameLocalIdentity(
  left: { readonly algorithmId: string; readonly profileFingerprint: string;
    readonly profileId: string },
  right: LocalCurrentRetrievalIdentitySnapshot,
): boolean {
  const rightAlgorithmId: string = right.algorithmId, rightProfileId: string = right.profileId;
  return left.algorithmId === rightAlgorithmId &&
    left.profileFingerprint === right.profileFingerprint &&
    left.profileId === rightProfileId;
}

function laneOrderIsCanonical(
  candidates: readonly FocusedMemoryReference[],
  composite: boolean,
): boolean {
  const local = candidates.filter(({ historicalSource }) => historicalSource === undefined);
  const historical = candidates.filter(({ historicalSource }) => historicalSource !== undefined);
  if (!canonicalLaneRanks(local) || !canonicalLaneRanks(historical) ||
    (!composite && historical.length > 0)) {return false;}
  const expected: FocusedMemoryReference[] = [];
  const maximum = Math.max(local.length, historical.length);
  for (let index = 0; index < maximum; index += 1) {
    if (local[index] !== undefined) {expected.push(local[index]!);}
    if (historical[index] !== undefined) {expected.push(historical[index]!);}
  }
  return expected.length === candidates.length &&
    expected.every((candidate, index) => candidate === candidates[index]);
}

function canonicalLaneRanks(candidates: readonly FocusedMemoryReference[]): boolean {
  return candidates.every((candidate, index) => {
    if (index === 0) {return true;}
    const previous = candidates[index - 1]!.retrievalAudit!;
    const current = candidate.retrievalAudit!;
    return current.providerRank > previous.providerRank ||
      (current.providerRank === previous.providerRank &&
        current.locator === previous.locator);
  });
}

async function canonicalDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalValue(value)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonicalValue);}
  if (typeof value !== "object" || value === null) {return value;}
  const encoder = new TextEncoder();
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => compareUtf8(left, right, encoder))
    .map(([key, nested]) => [key, canonicalValue(nested)]));
}

function compareUtf8(
  left: string,
  right: string,
  encoder: { readonly encode: (value: string) => Uint8Array },
): number {
  const leftBytes = encoder.encode(left), rightBytes = encoder.encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) {return difference;}
  }
  return leftBytes.length - rightBytes.length;
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
