import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, digest, exactRecord, safeId } from "./canonical.js";
import { CALL_KINDS, type AttemptIdentity, type CallKind, type SpendReservation } from
  "./execution.js";

interface BudgetClaim {
  readonly admissionId: string; readonly attemptId: string; readonly callKind: CallKind;
  readonly campaignRootSha256: string; readonly requestedEncryptedBytes: number;
  readonly requestedTokens: number; readonly requestDigestSha256: string;
  readonly repetition: 1 | 2 | 3;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_budget_claim.v1";
  readonly spendReservationSha256: string;
}

export async function loadAdmittedAttemptBudgetClaims(input: { readonly campaignRootSha256: string;
  readonly ledgerPath: string; readonly spendReservationSha256: string;
  readonly spend: SpendReservation }): Promise<readonly BudgetClaim[]> {
  const claims = await readBudgetClaims(input.ledgerPath, input.spendReservationSha256,
    input.campaignRootSha256);
  const admitted = admittedBudgetClaims(claims, input.spend);
  return Object.freeze(claims.filter(({ admissionId }) => admitted.has(admissionId)));
}

export async function claimDurableAttemptBudget(input: { readonly admissionId: string;
  readonly identity: AttemptIdentity; readonly ledgerPath: string;
  readonly requestDigestSha256: string; readonly requestedEncryptedBytes: number;
  readonly requestedTokens: number; readonly spend: SpendReservation }): Promise<{
    readonly acceptedAttempt?: BudgetClaim; readonly admitted: boolean }> {
  const claim: BudgetClaim = { admissionId: input.admissionId,
    attemptId: input.identity.attemptId, callKind: input.identity.callKind,
    campaignRootSha256: input.identity.campaignRootSha256,
    requestedEncryptedBytes: input.requestedEncryptedBytes,
    requestedTokens: input.requestedTokens,
    requestDigestSha256: digest(input.requestDigestSha256, "budget request digest"),
    repetition: input.identity.repetition,
    schemaVersion: "meeting_knowledge.semantic_quality_budget_claim.v1",
    spendReservationSha256: input.identity.spendReservationSha256 };
  await appendDurableClaim(input.ledgerPath, canonicalJson(claim));
  const claims = await readBudgetClaims(input.ledgerPath,
    input.identity.spendReservationSha256, input.identity.campaignRootSha256);
  const admitted = admittedBudgetClaims(claims, input.spend);
  const acceptedAttempt = claims.find((candidate) => candidate.attemptId ===
    input.identity.attemptId && admitted.has(candidate.admissionId));
  return Object.freeze({ ...(acceptedAttempt === undefined ? {} : { acceptedAttempt }),
    admitted: admitted.has(input.admissionId) });
}

async function appendDurableClaim(path: string, line: string): Promise<void> {
  await ensureDirectory(dirname(path));
  const bytes = Buffer.from(`${line}\n`);
  if (bytes.byteLength > 4096) {throw new Error("budget claim exceeds atomic record bound");}
  const handle = await open(path, "a", 0o600);
  try {
    const result = await handle.write(bytes, 0, bytes.byteLength);
    if (result.bytesWritten !== bytes.byteLength) {throw new Error("budget claim append was partial");}
    await handle.sync();
  } finally {await handle.close();}
  const directory = await open(dirname(path), "r");
  try {await directory.sync();} finally {await directory.close();}
}

async function readBudgetClaims(path: string, spendReservationSha256: string,
  campaignRootSha256: string): Promise<readonly BudgetClaim[]> {
  const text = await readCompleteLedger(path);
  return Object.freeze(text.slice(0, -1).split("\n").map((line) => {
    let value: unknown;
    try {value = JSON.parse(line) as unknown;} catch {throw new Error("budget claim is not JSON");}
    const record = exactRecord(value, ["admissionId", "attemptId", "callKind",
      "campaignRootSha256", "repetition", "requestedEncryptedBytes", "requestedTokens",
      "requestDigestSha256", "schemaVersion", "spendReservationSha256"], "budget claim");
    if (record.schemaVersion !== "meeting_knowledge.semantic_quality_budget_claim.v1" ||
      record.campaignRootSha256 !== campaignRootSha256 ||
      record.spendReservationSha256 !== spendReservationSha256 ||
      !CALL_KINDS.includes(record.callKind as CallKind) ||
      ![1, 2, 3].includes(Number(record.repetition)) ||
      ![record.requestedEncryptedBytes, record.requestedTokens].every((number) =>
        Number.isSafeInteger(number) && Number(number) >= 0) || Number(record.requestedTokens) < 1) {
      throw new Error("budget claim binding is invalid");
    }
    safeId(record.admissionId, "budget admission ID"); safeId(record.attemptId,
      "budget attempt ID"); digest(record.requestDigestSha256, "budget request digest");
    return record as unknown as BudgetClaim;
  }));
}

async function readCompleteLedger(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = (await readFile(path)).toString("utf8");
    if (text.endsWith("\n")) {return text;}
    await new Promise<void>((resolve) => {setImmediate(resolve);});
  }
  throw new Error("budget ledger contains a partial claim");
}

function admittedBudgetClaims(claims: readonly BudgetClaim[], spend: SpendReservation):
ReadonlySet<string> {
  const admitted = new Set<string>(); const attempts = new Set<string>();
  const callsByKind = Object.fromEntries(CALL_KINDS.map((kind) => [kind, 0])) as
    Record<CallKind, number>;
  let calls = 0, encryptedBytes = 0, tokens = 0;
  for (const claim of claims) {
    if (claim.repetition !== spend.repetition || !spend.allowedCallKinds.includes(claim.callKind)) {
      throw new Error("budget claim is outside its signed reservation scope");
    }
    if (attempts.has(claim.attemptId)) {continue;}
    attempts.add(claim.attemptId);
    const fits = calls + 1 <= spend.maxCalls &&
      callsByKind[claim.callKind] + 1 <= spend.maxCallsByKind[claim.callKind] &&
      tokens + claim.requestedTokens <= spend.maxTokens &&
      encryptedBytes + claim.requestedEncryptedBytes <= spend.maxEncryptedBytes;
    if (!fits) {continue;}
    admitted.add(claim.admissionId); calls += 1; callsByKind[claim.callKind] += 1;
    tokens += claim.requestedTokens; encryptedBytes += claim.requestedEncryptedBytes;
  }
  return admitted;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await stat(path)).isDirectory()) {throw new Error("durable path is not a directory");}
}
