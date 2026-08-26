import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { assertAttemptIdentity, CALL_KINDS, type AttemptIdentity, type CallKind,
  type JournalState, type SignedValue, type SpendReservation, type TerminalState,
  type VerifiedSpendReservation, verifyExternalSignedValue } from "./execution.js";
import { QualityCampaignAuthorityPolicy, type QualityAuthorityRole } from "./release.js";

interface ReservationRecord extends AttemptIdentity {
  readonly requestDigestSha256: string; readonly state: "provider_reserved";
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v3";
}

interface BudgetClaim {
  readonly admissionId: string;
  readonly attemptId: string;
  readonly callKind: CallKind;
  readonly campaignRootSha256: string;
  readonly requestedEncryptedBytes: number;
  readonly requestedTokens: number;
  readonly requestDigestSha256: string;
  readonly repetition: 1 | 2 | 3;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_budget_claim.v1";
  readonly spendReservationSha256: string;
}

export interface ProviderTerminalPayload extends Omit<ReservationRecord, "schemaVersion" | "state"> {
  readonly resultDigestSha256: string; readonly state: Exclude<TerminalState, "outcome_unknown">;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4";
}

interface TerminalRecord {
  readonly attemptId: string; readonly binding: ProviderTerminalPayload;
  readonly reservationSha256: string; readonly signedResult: SignedValue<unknown>;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal.v4";
  readonly state: Exclude<TerminalState, "outcome_unknown">;
}

interface BlockedRecord {
  readonly attemptId: string; readonly reasonCode: "terminal_binding_invalid";
  readonly reservationSha256: string; readonly state: "blocked_evidence";
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_blocked.v1";
}

export class DurableAttemptJournal {
  private readonly root: string;
  public constructor(root: string, public readonly authorityPolicy: QualityCampaignAuthorityPolicy,
    private readonly resultAuthorityRole: Extract<QualityAuthorityRole,
    "holdout_provider_result" | "provider_result"> = "provider_result") {
    if (!isAbsolute(root) || root.includes("\0")) {throw new Error("journal root must be absolute");}
    this.root = resolvePath(root);
  }

  private get resultAuthority(): { readonly keyId: string; readonly publicKeyPem: string } {
    return this.authorityPolicy.authority(this.resultAuthorityRole);
  }

  private async reserve(input: { readonly identity: AttemptIdentity;
    readonly requestDigestSha256: string }): Promise<ReservationRecord> {
    assertAttemptIdentity(input.identity);
    const record = Object.freeze({ ...input.identity, requestDigestSha256:
      digest(input.requestDigestSha256, "request digest"),
      schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v3" as const,
      state: "provider_reserved" as const });
    await writeCreateOnly(this.path(input.identity.attemptId, "reserved"), canonicalJson(record));
    return record;
  }

  public async admit(input: { readonly identity: AttemptIdentity;
    readonly requestDigestSha256: string; readonly requestedEncryptedBytes: number;
    readonly requestedTokens: number; readonly spend: VerifiedSpendReservation }): Promise<{
      readonly admitted: boolean; readonly reservation?: ReservationRecord;
      readonly state: JournalState }> {
    assertAttemptIdentity(input.identity, { campaignRootSha256: input.spend.payload.campaignRootSha256,
      releaseRootSha256: input.spend.payload.releaseRootSha256,
      spendReservationSha256: input.spend.spendReservationSha256 });
    const requested = [input.requestedEncryptedBytes, input.requestedTokens];
    if (requested.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      input.requestedTokens < 1) {throw new Error("provider budget claim is invalid");}
    const admissionId = randomUUID();
    const claim: BudgetClaim = { admissionId, attemptId: input.identity.attemptId,
      callKind: input.identity.callKind, campaignRootSha256: input.identity.campaignRootSha256,
      requestedEncryptedBytes: input.requestedEncryptedBytes,
      requestedTokens: input.requestedTokens,
      requestDigestSha256: digest(input.requestDigestSha256, "budget request digest"),
      repetition: input.identity.repetition,
      schemaVersion: "meeting_knowledge.semantic_quality_budget_claim.v1",
      spendReservationSha256: input.identity.spendReservationSha256 };
    const ledgerPath = this.budgetPath(input.identity.spendReservationSha256);
    await appendDurableLine(ledgerPath, canonicalJson(claim));
    const claims = await readBudgetClaims(ledgerPath, input.identity.spendReservationSha256,
      input.identity.campaignRootSha256);
    const admitted = admittedBudgetClaims(claims, input.spend.payload);
    if (!admitted.has(admissionId)) {
      const acceptedClaim = claims.find((candidate) => candidate.attemptId ===
        input.identity.attemptId && admitted.has(candidate.admissionId));
      if (acceptedClaim !== undefined) {
        if (acceptedClaim.requestDigestSha256 !== input.requestDigestSha256) {
          return { admitted: false, state: "blocked_evidence" };
        }
        await this.reserve({ identity: input.identity,
          requestDigestSha256: input.requestDigestSha256 });
      }
      return { admitted: false, state: "outcome_unknown" };
    }
    const reservation = await this.reserve({ identity: input.identity,
      requestDigestSha256: input.requestDigestSha256 });
    return { admitted: true, reservation, state: "provider_reserved" };
  }

  public async terminal(input: { readonly identity: AttemptIdentity;
    readonly reservation: ReservationRecord; readonly signedResult: unknown;
    readonly state: TerminalState; readonly expectedResultDigestSha256: string }):
  Promise<TerminalRecord> {
    if (input.state === "outcome_unknown") {
      throw new Error("outcome_unknown is inferred from uncertain effect, never asserted by a provider");
    }
    const signedResult = verifyExternalSignedValue(input.signedResult, this.resultAuthority.keyId,
      this.resultAuthority.publicKeyPem, "provider result");
    const reservation = await this.requireReservation(input.identity.attemptId);
    assertAttemptIdentity(input.identity);
    if (canonicalJson(reservation) !== canonicalJson(input.reservation)) {
      throw new Error("terminal result reservation is stale");}
    const result = decodeProviderTerminalPayload(signedResult.payload);
    if (result.resultDigestSha256 !== digest(input.expectedResultDigestSha256,
      "expected terminal result digest")) {
      throw new Error("terminal result digest differs from the exact provider response");
    }
    const expected = { ...reservation, resultDigestSha256: result.resultDigestSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4" as const,
      state: input.state };
    if (canonicalJson(result) !== canonicalJson(expected)) {
      throw new Error("terminal result does not bind the exact reserved exchange");}
    const record = Object.freeze({ attemptId: input.identity.attemptId, binding: result,
      reservationSha256: sha256(reservation),
      schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal.v4" as const,
      signedResult, state: input.state });
    await writeCreateOnly(this.path(input.identity.attemptId, "terminal"), canonicalJson(record));
    return record;
  }

  /** A durable reservation without an authenticated terminal is never retryable after restart. */
  public async recoveredState(input: { readonly identity: AttemptIdentity;
    readonly requestDigestSha256: string }):
  Promise<JournalState> {
    try {
      assertAttemptIdentity(input.identity);
      const [blockedValue, reservationValue, terminalValue] = await Promise.all([
        readOptional(this.path(input.identity.attemptId, "blocked")),
        readOptional(this.path(input.identity.attemptId, "reserved")),
        readOptional(this.path(input.identity.attemptId, "terminal")),
      ]);
      if (reservationValue === null && terminalValue === null && blockedValue === null) {
        return "never_reserved";}
      if (reservationValue === null) {return "blocked_evidence";}
      const reservation = decodeReservation(reservationValue);
      const expectedReservation = { ...input.identity,
        requestDigestSha256: digest(input.requestDigestSha256, "request digest"),
        schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v3" as const,
        state: "provider_reserved" as const };
      if (canonicalJson(reservation) !== canonicalJson(expectedReservation)) {
        return "blocked_evidence";}
      if (blockedValue !== null) {
        const blocked = decodeBlocked(blockedValue);
        if (blocked.attemptId !== input.identity.attemptId ||
          blocked.reservationSha256 !== sha256(reservation)) {
          throw new Error("blocked evidence membership is corrupt");
        }
      }
      if (terminalValue === null) {
        return blockedValue === null ? "outcome_unknown" : "blocked_evidence";}
      const terminal = decodeTerminal(terminalValue);
      const signed = verifyExternalSignedValue<ProviderTerminalPayload>(terminal.signedResult,
        this.resultAuthority.keyId, this.resultAuthority.publicKeyPem, "provider result");
      const payload = decodeProviderTerminalPayload(signed.payload);
      if (blockedValue !== null) {return "blocked_evidence";}
      if (terminal.attemptId !== input.identity.attemptId ||
        terminal.reservationSha256 !== sha256(reservation) || terminal.state !== payload.state ||
        canonicalJson(terminal.binding) !== canonicalJson(payload) ||
        canonicalJson(payload) !== canonicalJson({ ...reservation,
          resultDigestSha256: payload.resultDigestSha256,
          schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
          state: terminal.state })) {
        return "blocked_evidence";
      }
      return terminal.state;
    } catch {
      return "blocked_evidence";
    }
  }

  private async requireReservation(attemptId: string): Promise<ReservationRecord> {
    const value = await readOptional(this.path(attemptId, "reserved"));
    if (value === null) {throw new Error("provider terminal lacks a durable reservation");}
    return decodeReservation(value);
  }
  public async blockEvidence(reservation: ReservationRecord): Promise<void> {
    const record: BlockedRecord = { attemptId: reservation.attemptId,
      reasonCode: "terminal_binding_invalid", reservationSha256: sha256(reservation),
      schemaVersion: "meeting_knowledge.semantic_quality_provider_blocked.v1",
      state: "blocked_evidence" };
    await writeCreateOnly(this.path(reservation.attemptId, "blocked"), canonicalJson(record));
  }
  public async reconcileTerminal(input: { readonly identity: AttemptIdentity;
    readonly expectedResultDigestSha256: string; readonly requestDigestSha256: string;
    readonly signedResult: unknown;
    readonly state: Exclude<TerminalState, "outcome_unknown"> }): Promise<JournalState> {
    const reservation = await this.requireReservation(input.identity.attemptId);
    const expected = { ...input.identity, requestDigestSha256:
      digest(input.requestDigestSha256, "reconciled request digest"),
    schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v3" as const,
    state: "provider_reserved" as const };
    if (canonicalJson(reservation) !== canonicalJson(expected)) {
      throw new Error("reconciliation does not bind the durable attempt reservation");
    }
    return (await this.terminal({ identity: input.identity, reservation,
      expectedResultDigestSha256: input.expectedResultDigestSha256,
      signedResult: input.signedResult, state: input.state })).state;
  }
  private path(attemptId: string, kind: "blocked" | "reserved" | "terminal"): string {
    return join(this.root, attemptId, `${kind}.json`);
  }
  private budgetPath(spendReservationSha256: string): string {
    return join(this.root, "budgets", `${spendReservationSha256}.jsonl`);
  }
}
async function writeCreateOnly(path: string, bytes: string | Uint8Array): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporaryPath = `${path}.${randomUUID()}.pending`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {await handle.writeFile(bytes); await handle.sync();} finally {await handle.close();}
  try {
    await link(temporaryPath, path);
    const directory = await open(dirname(path), "r");
    try {await directory.sync();} finally {await directory.close();}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}
    const existing = await readFile(path); const requested = Buffer.from(bytes);
    if (!existing.equals(requested)) {
      throw new Error("create-only artifact conflicts", { cause: error });
    }
  } finally {await unlink(temporaryPath);}
}

async function appendDurableLine(path: string, line: string): Promise<void> {
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
    // A single O_APPEND write is the ordering primitive. A concurrent reader may
    // briefly observe that write before its final byte; yield without accepting
    // or repairing the record. A persistently torn record remains fail-closed.
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
    if (claim.repetition !== spend.repetition ||
      !spend.allowedCallKinds.includes(claim.callKind)) {
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

async function readOptional(path: string): Promise<unknown> {
  try {return JSON.parse((await readFile(path)).toString("utf8")) as unknown;}
  catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") {return null;} throw error;}
}

function decodeReservation(value: unknown): ReservationRecord {
  const record = exactRecord(value, ["attemptId", "callKind", "callOrdinal", "campaignRootSha256",
    "questionDigestSha256", "questionId", "releaseRootSha256", "repetition",
    "requestDigestSha256", "schemaVersion", "spendReservationSha256", "state"], "reservation");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_provider_reservation.v3" ||
    record.state !== "provider_reserved" || !CALL_KINDS.includes(record.callKind as CallKind) ||
    !Number.isSafeInteger(record.callOrdinal) || Number(record.callOrdinal) < 0 ||
    ![1, 2, 3].includes(record.repetition as number)) {
    throw new Error("reservation is invalid");
  }
  safeId(record.attemptId, "reserved attempt ID"); safeId(record.questionId,
    "reserved question ID"); digest(record.campaignRootSha256, "reserved campaign root");
  digest(record.questionDigestSha256, "reserved question digest");
  digest(record.releaseRootSha256, "reserved release root");
  digest(record.requestDigestSha256, "reserved request digest");
  digest(record.spendReservationSha256, "reserved spend reservation");
  return record as unknown as ReservationRecord;
}
function decodeTerminal(value: unknown): TerminalRecord {
  const record = exactRecord(value, ["attemptId", "binding", "reservationSha256",
    "schemaVersion", "signedResult", "state"], "terminal result");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_provider_terminal.v4" ||
    !["terminal_failure", "terminal_success"].includes(String(record.state))) {
    throw new Error("terminal state is invalid");
  }
  safeId(record.attemptId, "terminal attempt ID"); digest(record.reservationSha256, "terminal reservation");
  decodeProviderTerminalPayload(record.binding);
  return record as unknown as TerminalRecord;
}

function decodeBlocked(value: unknown): BlockedRecord {
  const record = exactRecord(value, ["attemptId", "reasonCode", "reservationSha256",
    "schemaVersion", "state"], "blocked evidence");
  if (record.reasonCode !== "terminal_binding_invalid" ||
    record.schemaVersion !== "meeting_knowledge.semantic_quality_provider_blocked.v1" ||
    record.state !== "blocked_evidence") {throw new Error("blocked evidence is invalid");}
  safeId(record.attemptId, "blocked attempt ID"); digest(record.reservationSha256, "blocked reservation");
  return record as unknown as BlockedRecord;
}
function decodeProviderTerminalPayload(value: unknown): ProviderTerminalPayload {
  const record = exactRecord(value, ["attemptId", "callKind", "callOrdinal",
    "campaignRootSha256", "questionDigestSha256", "questionId", "releaseRootSha256",
    "repetition", "requestDigestSha256", "resultDigestSha256", "schemaVersion",
    "spendReservationSha256", "state"],
  "provider result payload");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_provider_terminal_payload.v4" ||
    !["terminal_failure", "terminal_success"].includes(String(record.state))) {
    throw new Error("provider terminal payload is invalid");
  }
  digest(record.resultDigestSha256, "terminal result digest");
  const { resultDigestSha256, ...reservationFields } = record;
  const reservation = decodeReservation({ ...reservationFields,
    schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v3",
    state: "provider_reserved" });
  return { ...reservation, resultDigestSha256: String(resultDigestSha256),
    schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
    state: record.state as ProviderTerminalPayload["state"] };
}
