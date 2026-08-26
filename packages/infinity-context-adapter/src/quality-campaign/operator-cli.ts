import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { canonicalJson, digest, exactRecord } from "./canonical.js";
import { EXIT_OUTCOME_UNKNOWN, EXIT_SAFE_PAUSE } from "./execution.js";

export const QUALITY_CAMPAIGN_COMMANDS = Object.freeze([
  "verify-bind", "preflight", "execute", "resume", "status", "adjudicate",
  "adjudicate-resume", "retention", "cleanup-absence", "final-admission",
  "holdout-execute", "holdout-adjudicate", "holdout-cleanup", "holdout-status",
  "holdout-resume",
] as const);
export type QualityCampaignCommand = typeof QUALITY_CAMPAIGN_COMMANDS[number];

export type OperatorExit = 0 | 1 | typeof EXIT_SAFE_PAUSE | typeof EXIT_OUTCOME_UNKNOWN;
export const OPERATOR_STATUSES = Object.freeze([
  "completed", "failed", "outcome_unknown", "paused",
] as const);
export type OperatorStatus = typeof OPERATOR_STATUSES[number];
export const SAFE_OPERATOR_BLOCKER_CODES = Object.freeze([
  "authorization_missing", "campaign_incomplete", "cleanup_incomplete", "corrupt_evidence", "outcome_unknown",
  "retention_incomplete", "threshold_not_met",
] as const);
export const SAFE_OPERATOR_ERROR_CODES = Object.freeze([
  "admission_invalid", "evidence_invalid", "internal_failure", "provider_effect_unknown",
  "retention_invalid",
] as const);
export const SAFE_OPERATOR_COUNTERS = Object.freeze([
  "artifactCount", "attemptsBlocked", "attemptsCompleted", "attemptsUnknown", "outcomeCount",
  "completedOutcomes", "maximumObservedConcurrency", "providerCalls", "questionCount",
  "repetition", "targetCount", "totalStoredBytes",
] as const);
export const SAFE_OPERATOR_DIGESTS = Object.freeze([
  "adjudicationSetSha256", "campaignRootSha256", "cleanupReceiptSha256",
  "finalAdmissionSha256", "holdoutCheckpointSha256", "holdoutExecutionSha256",
  "inventorySha256", "metricsSha256", "qualifiedCheckpointSha256", "releaseRootSha256",
  "rootBindingSha256", "separateReportSha256", "terminalAttemptSetSha256",
] as const);
export type SafeOperatorBlockerCode = typeof SAFE_OPERATOR_BLOCKER_CODES[number];
export type SafeOperatorErrorCode = typeof SAFE_OPERATOR_ERROR_CODES[number];
export type SafeOperatorCounter = typeof SAFE_OPERATOR_COUNTERS[number];
export type SafeOperatorDigest = typeof SAFE_OPERATOR_DIGESTS[number];
export interface OperatorSafeReceipt extends Readonly<Record<string, unknown>> {
  readonly counters: Readonly<Partial<Record<SafeOperatorCounter, number>>>;
  readonly digests: Readonly<Partial<Record<SafeOperatorDigest, string>>>;
  readonly errorCode: SafeOperatorErrorCode | null;
}
export interface OperatorResult {
  readonly blockers: readonly SafeOperatorBlockerCode[];
  readonly command: QualityCampaignCommand;
  readonly receipt: OperatorSafeReceipt;
  readonly status: OperatorStatus;
}

export interface QualityCampaignOperatorHandlers {
  run(input: { readonly command: QualityCampaignCommand;
    readonly phaseInput: Readonly<Record<string, unknown>> }): Promise<OperatorResult>;
}

/** Transport-only CLI. It never prints private values, only create-only safe receipts. */
export async function runQualityCampaignOperatorCli(input: { readonly argv: readonly string[];
  readonly handlers: QualityCampaignOperatorHandlers; readonly statusReceiptPath: string;
  readonly writeSafeLine?: (line: string) => void }): Promise<OperatorExit> {
  const command = input.argv[0];
  if (!QUALITY_CAMPAIGN_COMMANDS.includes(command as QualityCampaignCommand)) {return 1;}
  const phaseInputPath = input.argv[1];
  if (phaseInputPath === undefined || !isAbsolute(phaseInputPath) || phaseInputPath.includes("\0")) {
    return 1;
  }
  let phaseInput: Readonly<Record<string, unknown>>;
  try {
    phaseInput = exactRecord(JSON.parse((await readFile(resolve(phaseInputPath))).toString("utf8")),
      ["payload", "schemaVersion"], "operator phase input");
  } catch {return 1;}
  let result: OperatorResult;
  try {result = await input.handlers.run({ command: command as QualityCampaignCommand,
    phaseInput });} catch {return 1;}
  let safe: OperatorSafeReceipt;
  try {safe = decodeSafeReceipt(result.receipt);} catch {return 1;}
  if (result.command !== command || !isSafeBlockerSet(result.blockers) ||
    !isConsistentResult(result, safe)) {return 1;}
  const receipt = Object.freeze({ blockers: result.blockers, command: result.command,
    counters: safe.counters, digests: safe.digests, errorCode: safe.errorCode, schemaVersion:
    "meeting_knowledge.semantic_quality_operator_status.v1", status: result.status });
  try {await writeCreateOnly(input.statusReceiptPath, canonicalJson(receipt));} catch {return 1;}
  input.writeSafeLine?.(canonicalJson(receipt));
  if (result.status === "outcome_unknown") {return EXIT_OUTCOME_UNKNOWN;}
  if (result.status === "paused") {return EXIT_SAFE_PAUSE;}
  return result.status === "completed" ? 0 : 1;
}

function decodeSafeReceipt(value: unknown): OperatorSafeReceipt {
  const record = exactRecord(value, ["counters", "digests", "errorCode"],
    "operator safe receipt");
  const counters = decodeSafeMap(record.counters, SAFE_OPERATOR_COUNTERS, (item, label) => {
    if (!Number.isSafeInteger(item) || Number(item) < 0 || Number(item) > 1_000_000_000_000) {
      throw new Error(`${label} counter is invalid`);
    }
    return Number(item);
  }, "operator counters");
  const digests = decodeSafeMap(record.digests, SAFE_OPERATOR_DIGESTS,
    (item, label) => digest(item, label), "operator digests");
  if (record.errorCode !== null &&
    !SAFE_OPERATOR_ERROR_CODES.includes(record.errorCode as SafeOperatorErrorCode)) {
    throw new Error("operator error code is unsafe");
  }
  return Object.freeze({ counters, digests,
    errorCode: record.errorCode as SafeOperatorErrorCode | null });
}

function decodeSafeMap<T extends string, V>(value: unknown, keys: readonly T[],
  decode: (item: unknown, label: string) => V, label: string): Readonly<Partial<Record<T, V>>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const output: Partial<Record<T, V>> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keys.includes(key as T)) {throw new Error(`${label} contains an unsafe key`);}
    output[key as T] = decode(item, `${label}.${key}`);
  }
  return Object.freeze(output);
}

function isSafeBlockerSet(value: readonly string[]): value is readonly SafeOperatorBlockerCode[] {
  return value.length <= SAFE_OPERATOR_BLOCKER_CODES.length &&
    new Set(value).size === value.length &&
    value.every((item) => SAFE_OPERATOR_BLOCKER_CODES.includes(item as SafeOperatorBlockerCode));
}

function isConsistentResult(result: OperatorResult, receipt: OperatorSafeReceipt): boolean {
  if (!OPERATOR_STATUSES.includes(result.status)) {return false;}
  if (result.status === "completed") {
    return result.blockers.length === 0 && receipt.errorCode === null;
  }
  if (result.status === "failed") {return receipt.errorCode !== null;}
  return result.blockers.length > 0 && receipt.errorCode === null;
}

async function writeCreateOnly(path: string, bytes: string): Promise<void> {
  if (!isAbsolute(path) || path.includes("\0")) {throw new Error("status path must be absolute");}
  const handle = await open(resolve(path), "wx", 0o600);
  try {await handle.writeFile(bytes); await handle.sync();} finally {await handle.close();}
  const directory = await open(dirname(resolve(path)), "r");
  try {await directory.sync();} finally {await directory.close();}
}
