import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

import { claimDurableAttemptBudget } from "./attempt-budget-ledger.js";
import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { assertAttemptIdentity, CALL_KINDS, type AttemptIdentity, type CallKind,
  type JournalState, type SignedValue, type TerminalState,
  type VerifiedSpendReservation, verifyExternalSignedValue } from "./execution.js";
import { QualityCampaignAuthorityPolicy, type QualityAuthorityRole } from "./release.js";

interface ReservationRecord extends AttemptIdentity {
  readonly requestDigestSha256: string; readonly state: "provider_reserved";
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v3";
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

interface ExchangeBytesRecord {
  readonly attemptId: string; readonly requestBase64: string;
  readonly requestDigestSha256: string; readonly resultEnvelopeBase64: string;
  readonly resultEnvelopeDigestSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_exchange_bytes.v1";
}

export interface CompletedProviderExchange {
  readonly identity: AttemptIdentity; readonly requestBytes: Uint8Array;
  readonly requestDigestSha256: string; readonly resultEnvelopeBytes: Uint8Array;
  readonly resultEnvelopeDigestSha256: string; readonly signedResult: SignedValue<unknown>;
  readonly terminalDigestSha256: string;
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
    const ledgerPath = this.budgetPath(input.identity.spendReservationSha256);
    const budget = await claimDurableAttemptBudget({ admissionId, identity: input.identity,
      ledgerPath, requestDigestSha256: input.requestDigestSha256,
      requestedEncryptedBytes: input.requestedEncryptedBytes,
      requestedTokens: input.requestedTokens, spend: input.spend.payload });
    if (!budget.admitted) {
      const acceptedClaim = budget.acceptedAttempt;
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
    readonly requestBytes: Uint8Array; readonly resultEnvelopeBytes: Uint8Array;
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
    const exchange = encodeExchangeBytes(input.identity.attemptId, input.requestBytes,
      input.resultEnvelopeBytes);
    if (exchange.requestDigestSha256 !== reservation.requestDigestSha256 ||
      exchange.resultEnvelopeDigestSha256 !== result.resultDigestSha256) {
      throw new Error("terminal bytes differ from the exact reserved exchange");
    }
    const record = Object.freeze({ attemptId: input.identity.attemptId, binding: result,
      reservationSha256: sha256(reservation),
      schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal.v4" as const,
      signedResult, state: input.state });
    await writeCreateOnly(this.path(input.identity.attemptId, "exchange"), canonicalJson(exchange));
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
    readonly requestBytes: Uint8Array; readonly resultEnvelopeBytes: Uint8Array;
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
      requestBytes: input.requestBytes, resultEnvelopeBytes: input.resultEnvelopeBytes,
      signedResult: input.signedResult, state: input.state })).state;
  }
  public async completedExchange(identity: AttemptIdentity): Promise<CompletedProviderExchange> {
    assertAttemptIdentity(identity);
    const [reservationValue, terminalValue, exchangeValue] = await Promise.all([
      readOptional(this.path(identity.attemptId, "reserved")),
      readOptional(this.path(identity.attemptId, "terminal")),
      readOptional(this.path(identity.attemptId, "exchange")),
    ]);
    if (reservationValue === null || terminalValue === null || exchangeValue === null) {
      throw new Error("exact completed exchange bytes are missing");
    }
    const reservation = decodeReservation(reservationValue);
    const terminal = decodeTerminal(terminalValue);
    const exchange = decodeExchangeBytes(exchangeValue);
    const signedResult = verifyExternalSignedValue<ProviderTerminalPayload>(terminal.signedResult,
      this.resultAuthority.keyId, this.resultAuthority.publicKeyPem, "provider result");
    const requestBytes = Buffer.from(exchange.requestBase64, "base64");
    const resultEnvelopeBytes = Buffer.from(exchange.resultEnvelopeBase64, "base64");
    const expectedReservation = { ...identity, requestDigestSha256:
      exchange.requestDigestSha256, schemaVersion:
      "meeting_knowledge.semantic_quality_provider_reservation.v3", state: "provider_reserved" };
    if (canonicalJson(reservation) !== canonicalJson(expectedReservation) ||
      terminal.state !== "terminal_success" || exchange.attemptId !== identity.attemptId ||
      terminal.attemptId !== identity.attemptId || terminal.reservationSha256 !== sha256(reservation) ||
      exchange.requestDigestSha256 !== reservation.requestDigestSha256 ||
      exchange.resultEnvelopeDigestSha256 !== terminal.binding.resultDigestSha256 ||
      sha256(requestBytes) !== exchange.requestDigestSha256 || sha256(resultEnvelopeBytes) !==
        exchange.resultEnvelopeDigestSha256 || canonicalJson(terminal.binding) !==
        canonicalJson(signedResult.payload)) {
      throw new Error("exact completed exchange is corrupt or substituted");
    }
    return Object.freeze({ identity, requestBytes, requestDigestSha256:
      exchange.requestDigestSha256, resultEnvelopeBytes, resultEnvelopeDigestSha256:
      exchange.resultEnvelopeDigestSha256, signedResult, terminalDigestSha256:
      sha256(signedResult) });
  }
  private path(attemptId: string, kind: "blocked" | "exchange" | "reserved" | "terminal"): string {
    return join(this.root, attemptId, `${kind}.json`);
  }
  private budgetPath(spendReservationSha256: string): string {
    return join(this.root, "budgets", `${spendReservationSha256}.jsonl`);
  }
}

function encodeExchangeBytes(attemptId: string, requestBytes: Uint8Array,
  resultEnvelopeBytes: Uint8Array): ExchangeBytesRecord {
  return Object.freeze({ attemptId, requestBase64: Buffer.from(requestBytes).toString("base64"),
    requestDigestSha256: sha256(requestBytes), resultEnvelopeBase64:
      Buffer.from(resultEnvelopeBytes).toString("base64"), resultEnvelopeDigestSha256:
      sha256(resultEnvelopeBytes), schemaVersion:
      "meeting_knowledge.semantic_quality_exchange_bytes.v1" });
}

function decodeExchangeBytes(value: unknown): ExchangeBytesRecord {
  const record = exactRecord(value, ["attemptId", "requestBase64", "requestDigestSha256",
    "resultEnvelopeBase64", "resultEnvelopeDigestSha256", "schemaVersion"],
  "exact exchange bytes");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_exchange_bytes.v1" ||
    typeof record.requestBase64 !== "string" || typeof record.resultEnvelopeBase64 !== "string") {
    throw new Error("exact exchange bytes are invalid");
  }
  safeId(record.attemptId, "exchange attempt");
  digest(record.requestDigestSha256, "exchange request digest");
  digest(record.resultEnvelopeDigestSha256, "exchange result digest");
  return record as unknown as ExchangeBytesRecord;
}
async function writeCreateOnly(path: string, bytes: string | Uint8Array): Promise<void> {
  const directoryPath = dirname(path);
  await ensureDirectory(directoryPath);
  const temporaryPath = join(directoryPath, `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  let published = false;
  try {
    await link(temporaryPath, path);
    published = true;
    await syncDirectory(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}
    const existing = await readFile(path);
    const requested = Buffer.from(bytes);
    if (!existing.equals(requested)) {
      throw new Error("create-only artifact conflicts", { cause: error });
    }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
    });
    if (published) {await syncDirectory(directoryPath);}
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {await directory.sync();} finally {await directory.close();}
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
