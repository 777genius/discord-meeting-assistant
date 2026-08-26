import { createPublicKey, verify } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { FROZEN_ANSWER_EXECUTION } from "./release.js";

export const EXIT_SAFE_PAUSE = 20;
export const EXIT_OUTCOME_UNKNOWN = 21;

export interface SpendReservation {
  readonly campaignRootSha256: string;
  readonly expiresAtEpochMs: number;
  readonly maxCalls: number;
  readonly maxEncryptedBytes: number;
  readonly maxTokens: number;
  readonly model: "gpt-5.6-sol";
  readonly provider: string;
  readonly reasoning: "xhigh";
  readonly releaseRootSha256: string;
  readonly repetition: 1 | 2 | 3;
  readonly serviceTier: "default";
}

export interface SignedValue<T> {
  readonly payload: T;
  readonly signatureBase64: string;
  readonly signerKeyId: string;
}

export function verifySpendReservations(input: {
  readonly authorityKeyId: string;
  readonly authorityPublicKeyPem: string;
  readonly campaignRootSha256: string;
  readonly nowEpochMs: number;
  readonly releaseRootSha256: string;
  readonly reservations: readonly unknown[];
}): readonly SignedValue<SpendReservation>[] {
  if (input.reservations.length !== 3) {throw new Error("exactly three spend reservations are required");}
  return Object.freeze(input.reservations.map((value, index) => {
    const signed = verifyExternalSignedValue<SpendReservation>(value, input.authorityKeyId,
      input.authorityPublicKeyPem, "spend reservation");
    const keys = ["campaignRootSha256", "expiresAtEpochMs", "maxCalls", "maxEncryptedBytes",
      "maxTokens", "model", "provider", "reasoning", "releaseRootSha256", "repetition",
      "serviceTier"];
    const record = exactRecord(signed.payload, keys, "spend reservation payload");
    if (record.repetition !== index + 1 || record.campaignRootSha256 !==
      input.campaignRootSha256 || record.releaseRootSha256 !== input.releaseRootSha256 ||
      typeof record.expiresAtEpochMs !== "number" || record.expiresAtEpochMs <= input.nowEpochMs ||
      typeof record.maxCalls !== "number" || record.maxCalls < 240 ||
      typeof record.maxTokens !== "number" || record.maxTokens < 1 ||
      typeof record.maxEncryptedBytes !== "number" || record.maxEncryptedBytes < 1 ||
      typeof record.provider !== "string" || record.provider.trim() === "" ||
      record.model !== FROZEN_ANSWER_EXECUTION.model ||
      record.reasoning !== FROZEN_ANSWER_EXECUTION.reasoning ||
      record.serviceTier !== FROZEN_ANSWER_EXECUTION.serviceTier ||
      ![record.expiresAtEpochMs, record.maxCalls, record.maxTokens,
        record.maxEncryptedBytes].every(Number.isSafeInteger)) {
      throw new Error("spend reservation binding is invalid");
    }
    return signed;
  }));
}

export type CallKind = "adjudicator_1" | "adjudicator_2" | "answer" | "capability" |
  "resolver" | "retrieval";
export type TerminalState = "terminal_failure" | "terminal_success" | "outcome_unknown";
export type JournalState = "blocked_evidence" | "never_reserved" | "provider_reserved" |
  TerminalState;

export interface AttemptIdentity {
  readonly attemptId: string;
  readonly callKind: CallKind;
  readonly callOrdinal: number;
  readonly questionDigestSha256: string;
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3;
}

export function attemptIdentity(input: Omit<AttemptIdentity, "attemptId"> & {
  readonly campaignRootSha256: string }): AttemptIdentity {
  digest(input.campaignRootSha256, "campaign root");
  digest(input.questionDigestSha256, "question digest");
  safeId(input.questionId, "question ID");
  if (!CALL_KINDS.includes(input.callKind) || ![1, 2, 3].includes(input.repetition) ||
    !Number.isSafeInteger(input.callOrdinal) || input.callOrdinal < 0) {
    throw new Error("attempt identity is invalid");
  }
  return Object.freeze({ attemptId: `sqv4-${sha256({ ...input,
    schemaVersion: "meeting_knowledge.semantic_quality_attempt.v2" })}`,
    callKind: input.callKind, callOrdinal: input.callOrdinal,
    questionDigestSha256: input.questionDigestSha256, questionId: input.questionId,
    repetition: input.repetition });
}

interface ReservationRecord extends AttemptIdentity {
  readonly campaignRootSha256: string;
  readonly requestDigestSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v2";
  readonly state: "provider_reserved";
}

export interface ProviderTerminalPayload extends Omit<ReservationRecord, "schemaVersion" | "state"> {
  readonly resultDigestSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v3";
  readonly state: Exclude<TerminalState, "outcome_unknown">;
}

interface TerminalRecord {
  readonly attemptId: string;
  readonly binding: ProviderTerminalPayload;
  readonly reservationSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal.v3";
  readonly signedResult: SignedValue<unknown>;
  readonly state: Exclude<TerminalState, "outcome_unknown">;
}

interface BlockedRecord {
  readonly attemptId: string;
  readonly reasonCode: "terminal_binding_invalid";
  readonly reservationSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_blocked.v1";
  readonly state: "blocked_evidence";
}

export class DurableAttemptJournal {
  private readonly root: string;
  public constructor(root: string, private readonly resultAuthority: {
    readonly keyId: string; readonly publicKeyPem: string }) {
    if (!isAbsolute(root) || root.includes("\0")) {throw new Error("journal root must be absolute");}
    this.root = resolve(root);
  }

  public async reserve(input: { readonly campaignRootSha256: string;
    readonly identity: AttemptIdentity; readonly requestDigestSha256: string }):
  Promise<ReservationRecord> {
    assertAttemptIdentity(input.identity, input.campaignRootSha256);
    const record = Object.freeze({ ...input.identity, campaignRootSha256:
      digest(input.campaignRootSha256, "campaign root"), requestDigestSha256:
      digest(input.requestDigestSha256, "request digest"),
      schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v2" as const,
      state: "provider_reserved" as const });
    await writeCreateOnly(this.path(input.identity.attemptId, "reserved"), canonicalJson(record));
    return record;
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
    assertAttemptIdentity(input.identity, reservation.campaignRootSha256);
    if (canonicalJson(reservation) !== canonicalJson(input.reservation)) {
      throw new Error("terminal result reservation is stale");
    }
    const result = decodeProviderTerminalPayload(signedResult.payload);
    if (result.resultDigestSha256 !== digest(input.expectedResultDigestSha256,
      "expected terminal result digest")) {
      throw new Error("terminal result digest differs from the exact provider response");
    }
    const expected = { ...reservation, resultDigestSha256: result.resultDigestSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v3" as const,
      state: input.state };
    if (canonicalJson(result) !== canonicalJson(expected)) {
      throw new Error("terminal result does not bind the exact reserved exchange");
    }
    const record = Object.freeze({ attemptId: input.identity.attemptId, binding: result,
      reservationSha256: sha256(reservation),
      schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal.v3" as const,
      signedResult, state: input.state });
    await writeCreateOnly(this.path(input.identity.attemptId, "terminal"), canonicalJson(record));
    return record;
  }

  /** A durable reservation without an authenticated terminal is never retryable after restart. */
  public async recoveredState(input: { readonly campaignRootSha256: string;
    readonly identity: AttemptIdentity; readonly requestDigestSha256: string }):
  Promise<JournalState> {
    try {
      assertAttemptIdentity(input.identity, input.campaignRootSha256);
      const [blockedValue, reservationValue, terminalValue] = await Promise.all([
        readOptional(this.path(input.identity.attemptId, "blocked")),
        readOptional(this.path(input.identity.attemptId, "reserved")),
        readOptional(this.path(input.identity.attemptId, "terminal")),
      ]);
      if (reservationValue === null && terminalValue === null && blockedValue === null) {
        return "never_reserved";
      }
      if (reservationValue === null) {return "blocked_evidence";}
      const reservation = decodeReservation(reservationValue);
      const expectedReservation = { ...input.identity,
        campaignRootSha256: digest(input.campaignRootSha256, "campaign root"),
        requestDigestSha256: digest(input.requestDigestSha256, "request digest"),
        schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v2" as const,
        state: "provider_reserved" as const };
      if (canonicalJson(reservation) !== canonicalJson(expectedReservation)) {
        return "blocked_evidence";
      }
      if (blockedValue !== null) {
        const blocked = decodeBlocked(blockedValue);
        if (blocked.attemptId !== input.identity.attemptId ||
          blocked.reservationSha256 !== sha256(reservation)) {
          throw new Error("blocked evidence membership is corrupt");
        }
      }
      if (terminalValue === null) {
        return blockedValue === null ? "outcome_unknown" : "blocked_evidence";
      }
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
          schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v3",
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
  private path(attemptId: string, kind: "blocked" | "reserved" | "terminal"): string {
    return join(this.root, attemptId, `${kind}.json`);
  }
}

export interface ProviderExchangePort {
  exchange(input: { readonly attemptId: string; readonly request: Uint8Array }): Promise<{
    readonly effect: "certain_failure" | "certain_success" | "unknown";
    readonly resultDigestSha256?: string;
    readonly signedResult?: unknown;
  }>;
}

/** Exactly one call after a durable reservation. Ambiguous retrieval and answer effects are equal. */
export async function executeReservedExchange(input: { readonly campaignRootSha256: string;
  readonly identity: AttemptIdentity; readonly journal: DurableAttemptJournal;
  readonly port: ProviderExchangePort; readonly request: Uint8Array }):
Promise<JournalState> {
  assertAttemptIdentity(input.identity, input.campaignRootSha256);
  const requestDigestSha256 = sha256(input.request);
  const recovered = await input.journal.recoveredState({
    campaignRootSha256: input.campaignRootSha256, identity: input.identity, requestDigestSha256 });
  if (recovered !== "never_reserved") {return recovered;}
  const reservation = await input.journal.reserve({ campaignRootSha256: input.campaignRootSha256,
    identity: input.identity, requestDigestSha256 });
  const result = await input.port.exchange({ attemptId: input.identity.attemptId,
    request: input.request });
  if (result.effect === "unknown") {return "outcome_unknown";}
  if (result.signedResult === undefined || result.resultDigestSha256 === undefined) {
    await input.journal.blockEvidence(reservation).catch(() => null);
    return "blocked_evidence";
  }
  try {
    return (await input.journal.terminal({ identity: input.identity, reservation,
      expectedResultDigestSha256: result.resultDigestSha256, signedResult: result.signedResult,
      state: result.effect === "certain_success" ? "terminal_success" : "terminal_failure" })).state;
  } catch {
    await input.journal.blockEvidence(reservation).catch(() => null);
    return "blocked_evidence";
  }
}

export function verifyExternalSignedValue<T>(value: unknown, keyId: string,
  publicKeyPem: string, label: string):
SignedValue<T> {
  const record = exactRecord(value, ["payload", "signatureBase64", "signerKeyId"], label);
  if (record.signerKeyId !== keyId || typeof record.signatureBase64 !== "string") {
    throw new Error(`${label} signer is invalid`);
  }
  let valid = false;
  try {valid = verify(null, Buffer.from(canonicalJson(record.payload)), createPublicKey(publicKeyPem),
    Buffer.from(record.signatureBase64, "base64"));} catch {valid = false;}
  if (!valid) {throw new Error(`${label} signature is invalid`);}
  return Object.freeze(record as unknown as SignedValue<T>);
}

async function writeCreateOnly(path: string, bytes: string | Uint8Array): Promise<void> {
  await ensureDirectory(dirname(path));
  const handle = await open(path, "wx", 0o600).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}
    const existing = await readFile(path);
    const requested = Buffer.from(bytes);
    if (!existing.equals(requested)) {throw new Error("create-only artifact conflicts");}
    return null;
  });
  if (handle === null) {return;}
  try {await handle.writeFile(bytes); await handle.sync();} finally {await handle.close();}
  const directory = await open(dirname(path), "r");
  try {await directory.sync();} finally {await directory.close();}
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const value = await stat(path);
  if (!value.isDirectory()) {throw new Error("durable path is not a directory");}
}

async function readOptional(path: string): Promise<unknown> {
  try {return JSON.parse((await readFile(path)).toString("utf8")) as unknown;}
  catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") {return null;} throw error;}
}

function decodeReservation(value: unknown): ReservationRecord {
  const record = exactRecord(value, ["attemptId", "callKind", "callOrdinal", "campaignRootSha256",
    "questionDigestSha256", "questionId", "repetition", "requestDigestSha256",
    "schemaVersion", "state"], "reservation");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_provider_reservation.v2" ||
    record.state !== "provider_reserved" || !CALL_KINDS.includes(record.callKind as CallKind) ||
    !Number.isSafeInteger(record.callOrdinal) || Number(record.callOrdinal) < 0 ||
    ![1, 2, 3].includes(record.repetition as number)) {
    throw new Error("reservation is invalid");
  }
  safeId(record.attemptId, "reserved attempt ID");
  safeId(record.questionId, "reserved question ID");
  digest(record.campaignRootSha256, "reserved campaign root");
  digest(record.questionDigestSha256, "reserved question digest");
  digest(record.requestDigestSha256, "reserved request digest");
  return record as unknown as ReservationRecord;
}
function decodeTerminal(value: unknown): TerminalRecord {
  const record = exactRecord(value, ["attemptId", "binding", "reservationSha256",
    "schemaVersion", "signedResult", "state"], "terminal result");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_provider_terminal.v3" ||
    !["terminal_failure", "terminal_success"].includes(String(record.state))) {
    throw new Error("terminal state is invalid");
  }
  safeId(record.attemptId, "terminal attempt ID");
  digest(record.reservationSha256, "terminal reservation");
  decodeProviderTerminalPayload(record.binding);
  return record as unknown as TerminalRecord;
}

function decodeBlocked(value: unknown): BlockedRecord {
  const record = exactRecord(value, ["attemptId", "reasonCode", "reservationSha256",
    "schemaVersion", "state"], "blocked evidence");
  if (record.reasonCode !== "terminal_binding_invalid" ||
    record.schemaVersion !== "meeting_knowledge.semantic_quality_provider_blocked.v1" ||
    record.state !== "blocked_evidence") {throw new Error("blocked evidence is invalid");}
  safeId(record.attemptId, "blocked attempt ID");
  digest(record.reservationSha256, "blocked reservation");
  return record as unknown as BlockedRecord;
}

const CALL_KINDS: readonly CallKind[] = ["adjudicator_1", "adjudicator_2", "answer",
  "capability", "resolver", "retrieval"];

function assertAttemptIdentity(identity: AttemptIdentity, campaignRootSha256: string): void {
  const expected = attemptIdentity({ callKind: identity.callKind, callOrdinal: identity.callOrdinal,
    campaignRootSha256, questionDigestSha256: identity.questionDigestSha256,
    questionId: identity.questionId, repetition: identity.repetition });
  if (canonicalJson(identity) !== canonicalJson(expected)) {
    throw new Error("attempt identity does not reconstruct from the exact campaign binding");
  }
}

function decodeProviderTerminalPayload(value: unknown): ProviderTerminalPayload {
  const record = exactRecord(value, ["attemptId", "callKind", "callOrdinal",
    "campaignRootSha256", "questionDigestSha256", "questionId", "repetition",
    "requestDigestSha256", "resultDigestSha256", "schemaVersion", "state"],
  "provider result payload");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_provider_terminal_payload.v3" ||
    !["terminal_failure", "terminal_success"].includes(String(record.state))) {
    throw new Error("provider terminal payload is invalid");
  }
  digest(record.resultDigestSha256, "terminal result digest");
  const { resultDigestSha256, ...reservationFields } = record;
  const reservation = decodeReservation({ ...reservationFields,
    schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v2",
    state: "provider_reserved" });
  return { ...reservation, resultDigestSha256: String(resultDigestSha256),
    schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v3",
    state: record.state as ProviderTerminalPayload["state"] };
}
