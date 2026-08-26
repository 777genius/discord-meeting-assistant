import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { canonicalJson, exactRecord, sha256 } from "./canonical.js";
import { EXIT_OUTCOME_UNKNOWN, EXIT_SAFE_PAUSE } from "./execution.js";

export const QUALITY_CAMPAIGN_COMMANDS = Object.freeze([
  "verify-bind", "preflight", "execute", "resume", "status", "adjudicate",
  "adjudicate-resume", "retention", "cleanup-absence", "final-admission",
  "holdout-execute", "holdout-adjudicate", "holdout-cleanup", "holdout-status",
] as const);
export type QualityCampaignCommand = typeof QUALITY_CAMPAIGN_COMMANDS[number];

export type OperatorExit = 0 | 1 | typeof EXIT_SAFE_PAUSE | typeof EXIT_OUTCOME_UNKNOWN;
export interface OperatorResult {
  readonly blockers: readonly string[];
  readonly command: QualityCampaignCommand;
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly status: "completed" | "failed" | "outcome_unknown" | "paused";
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
  const receipt = Object.freeze({ blockers: result.blockers, command: result.command,
    receiptSha256: sha256(result.receipt), schemaVersion:
    "meeting_knowledge.semantic_quality_operator_status.v1", status: result.status });
  try {await writeCreateOnly(input.statusReceiptPath, canonicalJson(receipt));} catch {return 1;}
  input.writeSafeLine?.(canonicalJson(receipt));
  if (result.status === "outcome_unknown") {return EXIT_OUTCOME_UNKNOWN;}
  if (result.status === "paused") {return EXIT_SAFE_PAUSE;}
  return result.status === "completed" ? 0 : 1;
}

async function writeCreateOnly(path: string, bytes: string): Promise<void> {
  if (!isAbsolute(path) || path.includes("\0")) {throw new Error("status path must be absolute");}
  const handle = await open(resolve(path), "wx", 0o600);
  try {await handle.writeFile(bytes); await handle.sync();} finally {await handle.close();}
  const directory = await open(dirname(resolve(path)), "r");
  try {await directory.sync();} finally {await directory.close();}
}
