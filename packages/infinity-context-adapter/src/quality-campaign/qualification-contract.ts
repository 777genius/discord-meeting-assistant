import { canonicalJson, digest, exactRecord, sha256 } from "./canonical.js";
import type { CallKind } from "./execution.js";
import type { QualityCampaignRelease } from "./release.js";

/** The one production/evaluation contract named by ADR-0052. */
export const QUALIFICATION_PROVIDER_INPUT_CONTRACT = Object.freeze({
  answer: Object.freeze({ maximumInputUtf8Bytes: 16_000, maximumOutputBytes: 16_384,
    maximumOutputTokens: 2_048, repairCalls: Object.freeze({ maximum: 1, minimum: 0 }) }),
  retrieval: Object.freeze({ candidateLimit: 100, deadlineMs: 1_000,
    evidenceByteLimit: 16_000, maximumQueries: 4, neighborRadius: 0,
    responseByteLimit: 16_384, resultLimit: 10 }),
  schemaVersion: "meeting_knowledge.semantic_quality_provider_input_contract.v1",
});

export const QUALIFICATION_PROVIDER_INPUT_CONTRACT_SHA256 =
  sha256(QUALIFICATION_PROVIDER_INPUT_CONTRACT);

/** Thresholds are owned with the qualification contract, never by a scorer or adapter. */
export const QUALIFICATION_THRESHOLDS = Object.freeze({
  abstentionPrecision: Object.freeze({ denominator: 20, numerator: 19 }),
  abstentionRecall: Object.freeze({ denominator: 10, numerator: 9 }),
  citationEntailment: Object.freeze({ denominator: 1, numerator: 1 }),
  citationMembership: Object.freeze({ denominator: 1, numerator: 1 }),
  claimPrecision: Object.freeze({ denominator: 100, numerator: 97 }),
  completeQuestionRecallAt5: Object.freeze({ denominator: 10, numerator: 9 }),
  crossScopeLeakageMaximum: 0,
  firstRelevantReciprocalRank: Object.freeze({ denominator: 5, numerator: 4 }),
  locatorRecallAt5: Object.freeze({ denominator: 10, numerator: 9 }),
  maximumRetrievalLatencyP95Us: 3_000_000,
  speakerTimeAccuracy: Object.freeze({ denominator: 20, numerator: 19 }),
  unsupportedFactualClaimsMaximum: 0,
});

export interface QualificationExecutionBinding {
  readonly contractSha256: string;
  readonly maximumOutputBytes: number;
  readonly maximumOutputTokens: number;
  readonly model: "gpt-5.6-sol";
  readonly promptSha256: string;
  readonly runtimeSha256: string;
  readonly tokenizerSha256: string;
}

export interface QualificationProviderAccounting extends QualificationExecutionBinding {
  readonly candidateCount: number;
  readonly neighborRadius: number;
  readonly original: QualificationProviderCallAccounting;
  readonly repair: QualificationProviderCallAccounting;
  readonly resolver: QualificationProviderCallAccounting;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_accounting.v1";
}

export interface QualificationProviderCallAccounting {
  readonly callCount: number;
  readonly inputUtf8Bytes: number;
  readonly outputBytes: number;
}

export function qualificationExecutionBinding(release: QualityCampaignRelease):
QualificationExecutionBinding {
  return Object.freeze({ contractSha256: QUALIFICATION_PROVIDER_INPUT_CONTRACT_SHA256,
    maximumOutputBytes: QUALIFICATION_PROVIDER_INPUT_CONTRACT.answer.maximumOutputBytes,
    maximumOutputTokens: QUALIFICATION_PROVIDER_INPUT_CONTRACT.answer.maximumOutputTokens,
    model: release.model, promptSha256: digest(release.promptSha256, "qualification prompt"),
    runtimeSha256: digest(release.answerReleaseSha256, "qualification runtime"),
    tokenizerSha256: digest(release.tokenizerSha256, "qualification tokenizer") });
}

/** Counts the exact submitted UTF-8 surface, including the two LF separators. */
export function measureQualificationModelInput(input: { readonly outputSchema: string;
  readonly systemPrompt: string; readonly userPrompt: string }): {
  readonly fullInputUtf8Bytes: number; readonly modelInputSha256: string } {
  const record = exactRecord(input, ["outputSchema", "systemPrompt", "userPrompt"],
    "qualification model input");
  if (Object.values(record).some((value) => typeof value !== "string")) {
    throw new Error("qualification model input fields must be strings");
  }
  const bytes = new TextEncoder().encode(
    `${record.systemPrompt as string}\n${record.userPrompt as string}\n${record.outputSchema as string}`,
  );
  if (bytes.byteLength > QUALIFICATION_PROVIDER_INPUT_CONTRACT.answer.maximumInputUtf8Bytes) {
    throw new Error("qualification model input exceeds 16000 UTF-8 bytes");
  }
  return Object.freeze({ fullInputUtf8Bytes: bytes.byteLength, modelInputSha256: sha256(bytes) });
}

/**
 * Accepts only provider-authority accounting carried by a signed terminal. Callers cannot
 * substitute outcome counters: the exact shape and release bindings reconstruct here.
 */
export function assertQualificationProviderAccounting(value: unknown, input: {
  readonly callKind: CallKind; readonly release: QualityCampaignRelease }):
QualificationProviderAccounting {
  const record = exactRecord(value, ["candidateCount", "contractSha256", "maximumOutputBytes",
    "maximumOutputTokens", "model", "neighborRadius", "original", "promptSha256", "repair",
    "resolver", "runtimeSha256", "schemaVersion", "tokenizerSha256"],
  "qualification provider accounting");
  const binding = qualificationExecutionBinding(input.release);
  const observedBinding = { contractSha256: record.contractSha256,
    maximumOutputBytes: record.maximumOutputBytes, maximumOutputTokens: record.maximumOutputTokens,
    model: record.model, promptSha256: record.promptSha256, runtimeSha256: record.runtimeSha256,
    tokenizerSha256: record.tokenizerSha256 };
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_provider_accounting.v1" ||
    canonicalJson(observedBinding) !== canonicalJson(binding)) {
    throw new Error("qualification provider accounting lacks frozen production bindings");
  }
  const original = decodeCallAccounting(record.original, "original");
  const repair = decodeCallAccounting(record.repair, "repair");
  const resolver = decodeCallAccounting(record.resolver, "resolver");
  const candidateCount = exactNonnegativeInteger(record.candidateCount, "candidate count");
  const neighborRadius = exactNonnegativeInteger(record.neighborRadius, "neighbor radius");
  assertCallCardinality(input.callKind, { original, repair, resolver });
  if (candidateCount > QUALIFICATION_PROVIDER_INPUT_CONTRACT.retrieval.candidateLimit ||
    neighborRadius !== QUALIFICATION_PROVIDER_INPUT_CONTRACT.retrieval.neighborRadius ||
    input.callKind !== "retrieval" && candidateCount !== 0) {
    throw new Error("qualification retrieval accounting exceeds the frozen contract");
  }
  return Object.freeze({ ...binding, candidateCount, neighborRadius, original, repair, resolver,
    schemaVersion: "meeting_knowledge.semantic_quality_provider_accounting.v1" });
}

function decodeCallAccounting(value: unknown, label: string): QualificationProviderCallAccounting {
  const record = exactRecord(value, ["callCount", "inputUtf8Bytes", "outputBytes"],
    `${label} provider accounting`);
  const callCount = exactNonnegativeInteger(record.callCount, `${label} call count`);
  const inputUtf8Bytes = exactNonnegativeInteger(record.inputUtf8Bytes, `${label} input bytes`);
  const outputBytes = exactNonnegativeInteger(record.outputBytes, `${label} output bytes`);
  const maximumInput = QUALIFICATION_PROVIDER_INPUT_CONTRACT.answer.maximumInputUtf8Bytes;
  const maximumOutput = QUALIFICATION_PROVIDER_INPUT_CONTRACT.answer.maximumOutputBytes;
  if (callCount > 1 || inputUtf8Bytes > maximumInput || outputBytes > maximumOutput ||
    callCount === 0 && (inputUtf8Bytes !== 0 || outputBytes !== 0) ||
    callCount === 1 && inputUtf8Bytes < 1) {
    throw new Error(`${label} provider accounting exceeds the frozen contract`);
  }
  return Object.freeze({ callCount, inputUtf8Bytes, outputBytes });
}

function assertCallCardinality(callKind: CallKind, accounting: {
  readonly original: QualificationProviderCallAccounting;
  readonly repair: QualificationProviderCallAccounting;
  readonly resolver: QualificationProviderCallAccounting }): void {
  const expectedOriginal = ["adjudicator_1", "adjudicator_2", "answer"].includes(callKind) ? 1 : 0;
  const expectedResolver = callKind === "resolver" ? 1 : 0;
  const repairAllowed = callKind === "answer";
  if (accounting.original.callCount !== expectedOriginal ||
    accounting.resolver.callCount !== expectedResolver ||
    (!repairAllowed && accounting.repair.callCount !== 0)) {
    throw new Error("qualification provider accounting reveals missing or hidden calls");
  }
}

function exactNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`qualification ${label} is invalid`);
  }
  return Number(value);
}
