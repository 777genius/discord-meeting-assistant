/* oxlint-disable max-lines -- durable reservation, exchange, and terminal decoders form one journal boundary */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve as resolvePath } from "node:path";

import { claimDurableAttemptBudget, loadAdmittedAttemptBudgetClaims } from
  "./attempt-budget-ledger.js";
import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import type { CumulativeSpendLedgerPort, DurableSpendClaim } from "./cumulative-spend.js";
import { assertAttemptIdentity, CALL_KINDS, type AttemptIdentity, type CallKind,
  type AttemptJournalPort, type AttemptReservation, type JournalState, type SignedValue,
  type TerminalState,
  type VerifiedSpendReservation, verifyExternalSignedValue } from "./execution.js";
import { assertQualificationProviderAccounting,
  type QualificationProviderAccounting } from "./qualification-contract.js";
import { type PinnedReleaseDocument, QualityCampaignAuthorityPolicy,
  type QualityAuthorityRole, verifyPinnedReleaseDocument } from "./release.js";
import { joinFromHandle, openOrCreatePrivateQualityCampaignDirectory,
  openQualityCampaignDirectory, readCanonicalQualityCampaignJsonAt, readQualityCampaignBytesAt } from
  "./production-execution-corpus-custody.js";

const MAXIMUM_JOURNAL_RECORD_BYTES = 8_000_000;

type ReservationRecord = AttemptReservation;

export interface ProviderTerminalPayload extends Omit<ReservationRecord, "schemaVersion" | "state"> {
  readonly providerAccounting: QualificationProviderAccounting;
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

export class DurableAttemptJournal implements AttemptJournalPort, CumulativeSpendLedgerPort {
  private readonly state: Promise<{ readonly campaignName: string;
    readonly identityPrefix: string; readonly parent: FileHandle; readonly root: FileHandle }>;
  private readonly root: Promise<FileHandle>;
  private readonly budgets: Promise<FileHandle>;
  private closePromise: Promise<void> | undefined;
  private closeRequested = false;
  private activeOperations = 0;
  private idleWaiter: (() => void) | undefined;
  public constructor(root: string, public readonly authorityPolicy: QualityCampaignAuthorityPolicy,
    private readonly resultAuthorityRole: Extract<QualityAuthorityRole,
    "holdout_provider_result" | "provider_result"> = "provider_result") {
    if (!isAbsolute(root) || root.includes("\0")) {throw new Error("journal root must be absolute");}
    this.state = initializeBoundRoot(resolvePath(root));
    this.root = this.state.then(({ root: handle }) => handle);
    this.budgets = this.child(this.root, "budgets", "attempt budget root");
    void this.root.catch(() => null); void this.budgets.catch(() => null);
  }

  public async close(): Promise<void> {
    this.closeRequested = true;
    this.closePromise ??= (async () => {
      if (this.activeOperations > 0) {
        await new Promise<void>((resolve) => {this.idleWaiter = resolve;});
      }
      let failure: unknown;
      const initialized = await Promise.allSettled([this.budgets, this.state]);
      const handles: FileHandle[] = [];
      if (initialized[0].status === "fulfilled") {handles.push(initialized[0].value);}
      else {failure = initialized[0].reason;}
      if (initialized[1].status === "fulfilled") {
        handles.push(initialized[1].value.root, initialized[1].value.parent);
      } else {failure ??= initialized[1].reason;}
      for (const handle of handles) {
        try {await handle.close();} catch (error) {failure ??= error;}
      }
      if (failure !== undefined) {throw new Error("attempt journal close failed", { cause: failure });}
    })();
    await this.closePromise;
  }

  public async [Symbol.asyncDispose](): Promise<void> {await this.close();}

  private beginOperation(): () => void {
    if (this.closeRequested) {throw new Error("attempt journal is closed");}
    this.activeOperations += 1; let ended = false;
    return () => {
      if (ended) {return;} ended = true; this.activeOperations -= 1;
      if (this.activeOperations === 0) {this.idleWaiter?.(); this.idleWaiter = undefined;}
    };
  }

  private get resultAuthority(): { readonly keyId: string; readonly publicKeyPem: string } {
    return this.authorityPolicy.authority(this.resultAuthorityRole);
  }

  private async bindCampaign(campaignRootSha256: string): Promise<void> {
    const campaign = digest(campaignRootSha256, "journal campaign root");
    const { campaignName, parent, root } = await this.state; const metadata = await root.stat();
    await writeCreateOnly(parent, campaignName, canonicalJson({ campaignRootSha256: campaign,
      journalDev: metadata.dev, journalIno: metadata.ino,
      schemaVersion: "meeting_knowledge.semantic_quality_journal_campaign_identity.v1" }));
  }

  private async reserve(input: { readonly identity: AttemptIdentity;
    readonly requestDigestSha256: string }): Promise<ReservationRecord> {
    assertAttemptIdentity(input.identity);
    const record = Object.freeze({ ...input.identity, requestDigestSha256:
      digest(input.requestDigestSha256, "request digest"),
      schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v3" as const,
      state: "provider_reserved" as const });
    await writeCreateOnly(await this.root, this.name(input.identity.attemptId, "reserved"),
      canonicalJson(record));
    return record;
  }

  public async admit(input: { readonly identity: AttemptIdentity;
    readonly requestDigestSha256: string; readonly requestedEncryptedBytes: number;
    readonly requestedTokens: number; readonly spend: VerifiedSpendReservation }): Promise<{
      readonly admitted: boolean; readonly reservation?: ReservationRecord;
      readonly state: JournalState }> {
    const end = this.beginOperation(); try {
    await this.bindCampaign(input.identity.campaignRootSha256);
    assertAttemptIdentity(input.identity, { campaignRootSha256: input.spend.payload.campaignRootSha256,
      releaseRootSha256: input.spend.payload.releaseRootSha256,
      spendReservationSha256: input.spend.spendReservationSha256 });
    const requested = [input.requestedEncryptedBytes, input.requestedTokens];
    if (requested.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      input.requestedTokens < 1) {throw new Error("provider budget claim is invalid");}
    const admissionId = randomUUID();
    const state = await this.state;
    const budget = await claimDurableAttemptBudget({ admissionId, identity: input.identity,
      directory: await this.budgets, ledgerName: this.budgetName(
        input.identity.spendReservationSha256), identityDirectory: state.parent,
      identityName: `${state.identityPrefix}.${this.budgetName(
        input.identity.spendReservationSha256)}.identity.jsonl`,
      requestDigestSha256: input.requestDigestSha256,
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
    } finally {end();}
  }

  public async terminal(input: { readonly identity: AttemptIdentity;
    readonly release: PinnedReleaseDocument;
    readonly reservation: ReservationRecord; readonly signedResult: unknown;
    readonly requestBytes: Uint8Array; readonly resultEnvelopeBytes: Uint8Array;
    readonly state: TerminalState; readonly expectedResultDigestSha256: string }):
  Promise<TerminalRecord> {
    const end = this.beginOperation(); try {
    await this.bindCampaign(input.identity.campaignRootSha256);
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
    const release = verifyPinnedReleaseDocument(this.authorityPolicy, input.release);
    const providerAccounting = assertQualificationProviderAccounting(result.providerAccounting,
      { callKind: input.identity.callKind, release: release.release });
    if (result.resultDigestSha256 !== digest(input.expectedResultDigestSha256,
      "expected terminal result digest")) {
      throw new Error("terminal result digest differs from the exact provider response");
    }
    const expected = { ...reservation, providerAccounting,
      resultDigestSha256: result.resultDigestSha256,
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
    const root = await this.root;
    await writeCreateOnly(root, this.name(input.identity.attemptId, "exchange"), canonicalJson(exchange));
    await writeCreateOnly(root, this.name(input.identity.attemptId, "terminal"), canonicalJson(record));
    return record;
    } finally {end();}
  }

  /** A durable reservation without an authenticated terminal is never retryable after restart. */
  public async recoveredState(input: { readonly identity: AttemptIdentity;
    readonly release: PinnedReleaseDocument;
    readonly requestDigestSha256: string }):
  Promise<JournalState> {
    const end = this.beginOperation(); try {
    try {
      await this.bindCampaign(input.identity.campaignRootSha256);
      assertAttemptIdentity(input.identity);
      const root = await this.root;
      const [blockedValue, reservationValue, terminalValue] = await Promise.all([
        readOptional(root, this.name(input.identity.attemptId, "blocked")),
        readOptional(root, this.name(input.identity.attemptId, "reserved")),
        readOptional(root, this.name(input.identity.attemptId, "terminal")),
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
      const release = verifyPinnedReleaseDocument(this.authorityPolicy, input.release);
      const providerAccounting = assertQualificationProviderAccounting(payload.providerAccounting,
        { callKind: input.identity.callKind, release: release.release });
      if (blockedValue !== null) {return "blocked_evidence";}
      if (terminal.attemptId !== input.identity.attemptId ||
        terminal.reservationSha256 !== sha256(reservation) || terminal.state !== payload.state ||
        canonicalJson(terminal.binding) !== canonicalJson(payload) ||
        canonicalJson(payload) !== canonicalJson({ ...reservation,
          providerAccounting,
          resultDigestSha256: payload.resultDigestSha256,
          schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
          state: terminal.state })) {
        return "blocked_evidence";
      }
      return terminal.state;
    } catch {
      return "blocked_evidence";
    }} finally {end();}
  }

  private async requireReservation(attemptId: string): Promise<ReservationRecord> {
    const value = await readOptional(await this.root, this.name(attemptId, "reserved"));
    if (value === null) {throw new Error("provider terminal lacks a durable reservation");}
    return decodeReservation(value);
  }
  public async blockEvidence(reservation: ReservationRecord): Promise<void> {
    const end = this.beginOperation(); try {
    await this.bindCampaign(reservation.campaignRootSha256);
    const record: BlockedRecord = { attemptId: reservation.attemptId,
      reasonCode: "terminal_binding_invalid", reservationSha256: sha256(reservation),
      schemaVersion: "meeting_knowledge.semantic_quality_provider_blocked.v1",
      state: "blocked_evidence" };
    await writeCreateOnly(await this.root, this.name(reservation.attemptId, "blocked"),
      canonicalJson(record));
    } finally {end();}
  }
  public async reconcileTerminal(input: { readonly identity: AttemptIdentity;
    readonly expectedResultDigestSha256: string; readonly requestDigestSha256: string;
    readonly requestBytes: Uint8Array; readonly resultEnvelopeBytes: Uint8Array;
    readonly release: PinnedReleaseDocument;
    readonly signedResult: unknown;
    readonly state: Exclude<TerminalState, "outcome_unknown"> }): Promise<JournalState> {
    const end = this.beginOperation(); try {
    await this.bindCampaign(input.identity.campaignRootSha256);
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
      release: input.release, signedResult: input.signedResult, state: input.state })).state;
    } finally {end();}
  }
  public async completedExchange(identity: AttemptIdentity): Promise<CompletedProviderExchange> {
    const end = this.beginOperation(); try {
    await this.bindCampaign(identity.campaignRootSha256);
    assertAttemptIdentity(identity);
    const root = await this.root;
    const [reservationValue, terminalValue, exchangeValue] = await Promise.all([
      readOptional(root, this.name(identity.attemptId, "reserved")),
      readOptional(root, this.name(identity.attemptId, "terminal")),
      readOptional(root, this.name(identity.attemptId, "exchange")),
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
    } finally {end();}
  }
  private name(attemptId: string, kind: "blocked" | "exchange" | "reserved" | "terminal"): string {
    return `${safeId(attemptId, "journal attempt ID")}.${kind}.json`;
  }
  private budgetName(spendReservationSha256: string): string {
    return `${digest(spendReservationSha256, "journal spend reservation")}.jsonl`;
  }
  private async child(parentPromise: Promise<FileHandle>, name: string, label: string) {
    const parent = await parentPromise;
    try {await mkdir(joinFromHandle(parent, name), { mode: 0o700 }); await parent.sync();}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}}
    const child = await open(joinFromHandle(parent, name), constants.O_RDONLY |
      constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const metadata = await child.stat();
      if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
        throw new Error(`${label} is not a private directory`);
      }
      return child;
    } catch (error) {await child.close(); throw error;}
  }
  public async loadAdmittedClaims(spend: VerifiedSpendReservation):
  Promise<readonly DurableSpendClaim[]> {
    const end = this.beginOperation(); try {
    await this.bindCampaign(spend.payload.campaignRootSha256);
    const state = await this.state; const ledgerName = this.budgetName(spend.spendReservationSha256);
    return await loadAdmittedAttemptBudgetClaims({ campaignRootSha256:
      spend.payload.campaignRootSha256, directory: await this.budgets,
      identityDirectory: state.parent, identityName:
        `${state.identityPrefix}.${ledgerName}.identity.jsonl`, ledgerName, spend: spend.payload,
      spendReservationSha256: spend.spendReservationSha256 });
    } finally {end();}
  }
}

/** Closes an owned journal after all work settles while preserving the operation's failure. */
export async function withOwnedAttemptJournal<T>(journal: DurableAttemptJournal,
  operation: () => Promise<T>): Promise<T> {
  let value: T;
  try {value = await operation();}
  catch (operationError) {
    try {await journal.close();} catch { /* The operation failure remains authoritative. */ }
    throw operationError;
  }
  await journal.close();
  return value;
}

async function initializeBoundRoot(path: string): Promise<{
  readonly campaignName: string; readonly identityPrefix: string;
  readonly parent: FileHandle; readonly root: FileHandle }> {
  const root = await openOrCreatePrivateQualityCampaignDirectory(path, "attempt journal root");
  let parent: FileHandle | undefined;
  try {
    parent = await openQualityCampaignDirectory(dirname(path), "attempt journal trusted parent");
    const metadata = await root.stat(); const name = `.${basename(path)}.identity.json`;
    const binding = canonicalJson({ dev: metadata.dev, ino: metadata.ino,
      schemaVersion: "meeting_knowledge.semantic_quality_journal_identity.v1" });
    await writeCreateOnly(parent, name, binding);
    return { campaignName: `.${basename(path)}.campaign.json`,
      identityPrefix: `.${basename(path)}.budget`, parent, root };
  } catch (error) {
    try {await root.close();} finally {await parent?.close();}
    throw error;
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
async function writeCreateOnly(directory: FileHandle, name: string,
  bytes: string | Uint8Array): Promise<void> {
  const requested = Buffer.from(bytes);
  if (requested.byteLength === 0 || requested.byteLength > MAXIMUM_JOURNAL_RECORD_BYTES) {
    throw new Error("journal artifact exceeds its byte limit");
  }
  const temporaryName = `.${name}.${randomUUID()}.tmp`;
  const temporaryPath = joinFromHandle(directory, temporaryName);
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(requested);
    await handle.sync();
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== requested.byteLength) {
      throw new Error("journal temporary artifact changed during write");
    }
  } finally {
    await handle.close();
  }
  let published = false;
  try {
    await link(temporaryPath, joinFromHandle(directory, name));
    published = true;
    await directory.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}
    const existing = await readQualityCampaignBytesAt(directory, name,
      "existing journal artifact", MAXIMUM_JOURNAL_RECORD_BYTES);
    if (!existing.equals(requested)) {
      throw new Error("create-only artifact conflicts", { cause: error });
    }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
    });
    if (published) {await directory.sync();}
  }
}
async function readOptional(directory: FileHandle, name: string): Promise<unknown> {
  try {return await readCanonicalQualityCampaignJsonAt(directory, name, "journal artifact",
    MAXIMUM_JOURNAL_RECORD_BYTES);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
    (error as Error & { cause?: NodeJS.ErrnoException }).cause?.code === "ENOENT") {return null;}
    throw error;}
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
    "campaignRootSha256", "providerAccounting", "questionDigestSha256", "questionId", "releaseRootSha256",
    "repetition", "requestDigestSha256", "resultDigestSha256", "schemaVersion",
    "spendReservationSha256", "state"],
  "provider result payload");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_provider_terminal_payload.v4" ||
    !["terminal_failure", "terminal_success"].includes(String(record.state))) {
    throw new Error("provider terminal payload is invalid");
  }
  digest(record.resultDigestSha256, "terminal result digest");
  const { providerAccounting, resultDigestSha256, ...reservationFields } = record;
  const reservation = decodeReservation({ ...reservationFields,
    schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v3",
    state: "provider_reserved" });
  return { ...reservation, providerAccounting: providerAccounting as QualificationProviderAccounting,
    resultDigestSha256: String(resultDigestSha256),
    schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
    state: record.state as ProviderTerminalPayload["state"] };
}
