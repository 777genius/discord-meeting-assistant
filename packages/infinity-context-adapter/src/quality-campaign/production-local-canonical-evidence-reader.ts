import { createHash } from "node:crypto";

import { canonicalJson, digest, exactRecord } from "./canonical.js";
import { validateCanonicalRetrievalObservation,
  type SemanticQualityV4ArtifactKind, type SemanticQualityV4ArtifactReceipt } from
  "./canonical-execution-artifact-validation.js";
import { readProductionCanonicalArtifact } from
  "./production-canonical-execution-evidence.js";
import { decodeQualificationQuestionOutcome } from
  "./execute-admitted-qualification-question.js";
import type { MainCanonicalEvidenceProjection, MainCanonicalEvidenceVerificationPort } from
  "./production-ports.js";

const REQUIRED_KINDS = Object.freeze(["capability_request", "capability_response",
  "retrieval_request", "retrieval_response", "retrieval_observation",
  "answer_normalized_outcome"] as const satisfies readonly SemanticQualityV4ArtifactKind[]);

/** Read-only authentication of artifacts emitted by the installed main canonical SDK chain. */
export function createProductionLocalCanonicalEvidenceReader(input: { readonly artifactKey: Uint8Array;
  readonly artifactKeyId: string; readonly artifactRoot: string }): MainCanonicalEvidenceVerificationPort {
  if (input.artifactKey.byteLength !== 32 || input.artifactKeyId.trim() === "") {
    throw new Error("canonical artifact key is invalid");
  }
  const key = new Uint8Array(input.artifactKey);
  return Object.freeze({ verify: async (verification: Parameters<
    MainCanonicalEvidenceVerificationPort["verify"]>[0]) => {
    const { attempts, campaignRootSha256 } = verification;
    digest(campaignRootSha256, "local canonical evidence campaign root");
    if (attempts.length === 0 || new Set(attempts.map(({ attemptId }) => attemptId)).size !==
      attempts.length || attempts.some((attempt) => attempt.campaignRootSha256 !==
        campaignRootSha256)) {
      throw new Error("local canonical evidence inventory is empty, duplicated, or foreign");
    }
    const receipts = (await mapBounded(attempts, 8, async (attempt) =>
      await verifyAttempt(input.artifactRoot, key, input.artifactKeyId, attempt)))
      .flat().toSorted(compareReceipt);
    return Object.freeze({ inventorySha256: sha256(receipts) });
  } });
}

async function verifyAttempt(artifactRoot: string, artifactKey: Uint8Array,
  artifactKeyId: string, expected: MainCanonicalEvidenceProjection):
Promise<readonly SemanticQualityV4ArtifactReceipt[]> {
  const opened = new Map<SemanticQualityV4ArtifactKind, Awaited<ReturnType<
    typeof readProductionCanonicalArtifact>>>();
  for (const kind of REQUIRED_KINDS) {
    opened.set(kind, await readProductionCanonicalArtifact({ artifactKey, artifactKeyId, artifactRoot,
      attemptId: expected.attemptId, kind, rootBindingSha256: expected.campaignRootSha256 }));
  }
  const bytes = (kind: typeof REQUIRED_KINDS[number]) => opened.get(kind)!.plaintext;
  const hashes = [
    ["capability request", bytes("capability_request"), expected.capabilityRequestSha256],
    ["capability response", bytes("capability_response"), expected.capabilityResponseSha256],
    ["retrieval request", bytes("retrieval_request"), expected.retrievalRequestSha256],
    ["retrieval response", bytes("retrieval_response"), expected.retrievalResponseSha256],
  ] as const;
  for (const [label, value, expectedHash] of hashes) {
    if (sha256Bytes(value) !== digest(expectedHash, `external ${label}`)) {
      throw new Error(`local canonical ${label} differs from external terminal evidence`);
    }
  }
  const observationRecord = parseExactJson(bytes("retrieval_observation"), ["attemptId",
    "capabilityAndRetrievalLatencyUs", "capabilityBytes", "capabilitySha256", "requestBytes",
    "requestSha256", "responseBytes", "responseSha256", "routeLatencyUs", "schemaVersion"],
  "canonical retrieval observation");
  if (observationRecord.attemptId !== expected.attemptId || observationRecord.schemaVersion !==
    "meeting_knowledge.canonical_retrieval_observation.v1") {
    throw new Error("canonical retrieval observation is foreign");
  }
  const observation = validateCanonicalRetrievalObservation({ attemptId: expected.attemptId,
    exchange: { capabilityRequestBytes: bytes("capability_request"),
      capabilityResponseBytes: bytes("capability_response"),
      requestBytes: bytes("retrieval_request"), responseBytes: bytes("retrieval_response") },
    observation: { capabilityAndRetrievalLatencyUs: numberField(observationRecord,
      "capabilityAndRetrievalLatencyUs"), capabilityBytes: numberField(observationRecord,
      "capabilityBytes"), capabilitySha256: stringField(observationRecord, "capabilitySha256"),
    requestBytes: numberField(observationRecord, "requestBytes"), requestSha256:
      stringField(observationRecord, "requestSha256"), responseBytes:
      numberField(observationRecord, "responseBytes"), responseSha256:
      stringField(observationRecord, "responseSha256"), routeLatencyUs:
      numberField(observationRecord, "routeLatencyUs") } });
  if (observation.capabilityAndRetrievalLatencyUs !== expected.retrievalLatencyUs) {
    throw new Error("external retrieval latency differs from measured canonical SDK operation");
  }
  const outcome = decodeQualificationQuestionOutcome(JSON.parse(new TextDecoder("utf-8", {
    fatal: true }).decode(bytes("answer_normalized_outcome"))) as unknown);
  assertExactOutcomeRecords(outcome);
  if (outcome.status === "failed" || (outcome.status === "abstained") !==
    expected.answerAbstained || outcome.rawRetrievalResponseSha256 !== observation.responseSha256) {
    throw new Error("normalized canonical outcome differs from external outcome evidence");
  }
  const ranked = outcome.retrievalCandidates.map(({ locatorId }) => locatorId);
  const evidenceLocators = outcome.selectedTurns.map(({ sourceLocatorId }) => sourceLocatorId);
  const turnIds = outcome.selectedTurns.map(({ turnId }) => turnId);
  const byTurn = new Map(outcome.selectedTurns.map((turn) => [turn.turnId, turn.sourceLocatorId]));
  const citationLocators = outcome.citations.map((turnId) => byTurn.get(turnId));
  if (citationLocators.some((value) => value === undefined) ||
    canonicalJson(ranked) !== canonicalJson(expected.rankedLocatorIds) ||
    canonicalJson(evidenceLocators) !== canonicalJson(expected.evidenceLocatorIds) ||
    canonicalJson(turnIds) !== canonicalJson(expected.evidenceTurnIds) ||
    canonicalJson(citationLocators) !== canonicalJson(expected.citationLocatorIds)) {
    throw new Error("canonical outcome locators or turns differ from external evidence");
  }
  return REQUIRED_KINDS.map((kind) => opened.get(kind)!.receipt);
}

async function mapBounded<T, U>(values: readonly T[], concurrency: number,
  task: (value: T) => Promise<U>): Promise<U[]> {
  const results = Array.from<U>({ length: values.length });
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await task(values[index]!);
    }
  }));
  return results;
}

function assertExactOutcomeRecords(outcome: ReturnType<typeof decodeQualificationQuestionOutcome>): void {
  for (const candidate of outcome.retrievalCandidates) {
    exactRecord(candidate, ["contributions", "fusedScore", "locatorId", "providerRank"],
      "canonical retrieval candidate");
    if (typeof candidate.fusedScore !== "number" || !Number.isFinite(candidate.fusedScore)) {
      throw new Error("canonical retrieval candidate score is invalid");
    }
    for (const contribution of candidate.contributions) {
      exactRecord(contribution, ["contributionScorePicos", "providerLaneId", "providerRank",
        "queryId", "rawScoreKind", "rawScoreValue"], "canonical retrieval contribution");
    }
  }
  for (const turn of outcome.selectedTurns) {
    exactRecord(turn, ["endMs", "sourceLocatorId", "speakerId", "startMs", "text", "turnHash",
      "turnId"], "canonical selected turn");
    if (![turn.endMs, turn.startMs].every(Number.isSafeInteger) || turn.startMs < 0 ||
      turn.endMs < turn.startMs || [turn.sourceLocatorId, turn.speakerId, turn.text, turn.turnHash,
        turn.turnId].some((value) => typeof value !== "string" || value.length === 0)) {
      throw new Error("canonical selected turn is invalid");
    }
  }
}

function parseExactJson(bytes: Uint8Array, keys: readonly string[], label: string) {
  let value: unknown;
  try {value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;}
  catch (error) {throw new Error(`${label} is invalid`, { cause: error });}
  return exactRecord(value, keys, label);
}
function numberField(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {throw new Error("canonical retrieval observation is invalid");}
  return value;
}
function stringField(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {throw new Error("canonical retrieval observation is invalid");}
  return value;
}

function compareReceipt(left: SemanticQualityV4ArtifactReceipt,
  right: SemanticQualityV4ArtifactReceipt): number {
  return left.attemptId.localeCompare(right.attemptId) ||
    left.artifactKind.localeCompare(right.artifactKind);
}
function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
