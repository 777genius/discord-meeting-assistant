import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { type ArtifactReceipt, type AttemptIdentity,
  type AttemptJournalPort, type EncryptedArtifactKind, type JournalRecovery, type JournalState,
  type ProviderAuthorityBinding, type ProviderTerminalPayload, type ReservationRecord,
  type TerminalRecord } from "./execution.js";
import type { AdjudicationCallRequest, AdjudicationJournalPort } from "./adjudication.js";
import { nodeCampaignAuthentication } from "./production-authentication.js";

/** Create-only adjudication release/spend journal; reserved ambiguity is status-only on resume. */
export class DurableAdjudicationJournal implements AdjudicationJournalPort {
  private readonly root: string;
  public constructor(root: string) {
    if (!isAbsolute(root) || root.includes("\0")) {throw new Error("review journal root is invalid");}
    this.root = resolve(root);
  }
  public async recover(attemptId: string) {
    const reserved = await readOptional(this.path(attemptId, "reserved"));
    const terminal = await readOptional(this.path(attemptId, "terminal"));
    if (reserved === null) {
      if (terminal !== null) {throw new Error("adjudication terminal lacks reservation");}
      return Object.freeze({ state: "never_reserved" as const });
    }
    const binding = reserved as AdjudicationCallRequest;
    if (terminal === null) {return Object.freeze({ binding, state: "reserved" as const });}
    const record = exactRecord(terminal, ["bindingSha256", "receipt"], "adjudication terminal");
    if (record.bindingSha256 !== sha256(binding)) {throw new Error("adjudication terminal is foreign");}
    return Object.freeze({ binding, receipt: record.receipt, state: "terminal" as const });
  }
  public async reserve(binding: AdjudicationCallRequest): Promise<void> {
    await writeCreateOnly(this.path(binding.attemptId, "reserved"), canonicalJson(binding), true);
  }
  public async terminal(binding: AdjudicationCallRequest, receipt: unknown): Promise<void> {
    const recovered = await this.recover(binding.attemptId);
    if (recovered.state === "never_reserved") {throw new Error("adjudication terminal lacks reservation");}
    await writeCreateOnly(this.path(binding.attemptId, "terminal"), canonicalJson({
      bindingSha256: sha256(binding), receipt }), true);
  }
  private path(attemptId: string, kind: "reserved" | "terminal") {
    return join(this.root, attemptId, `${kind}.json`);
  }
}

/** Filesystem implementation of the application-owned exact-attempt journal port. */
export class DurableAttemptJournal implements AttemptJournalPort {
  private readonly root: string;
  public constructor(root: string, private readonly resultAuthority: {
    readonly keyId: string; readonly publicKeyPem: string }) {
    if (!isAbsolute(root) || root.includes("\0")) {throw new Error("journal root must be absolute");}
    this.root = resolve(root);
  }
  public async reserve(input: { readonly binding: ProviderAuthorityBinding;
    readonly identity: AttemptIdentity; readonly requestDigestSha256: string;
    readonly spendReceiptSha256: string }): Promise<ReservationRecord> {
    const record = Object.freeze({ ...input.identity, campaignRootSha256:
      digest(input.binding.campaignRootSha256, "campaign root"), predecessorResultDigestSha256:
      input.binding.predecessorResultDigestSha256 === null ? null : digest(
        input.binding.predecessorResultDigestSha256, "predecessor result"), releaseRootSha256:
      digest(input.binding.releaseRootSha256, "release root"), requestDigestSha256:
      digest(input.requestDigestSha256, "request digest"), schemaVersion:
      "meeting_knowledge.semantic_quality_provider_reservation.v2" as const,
      spendReceiptSha256: digest(input.spendReceiptSha256, "spend receipt"),
      spendReservationSha256: digest(input.binding.spendReservationSha256, "spend reservation"),
      state: "provider_reserved" as const });
    await writeCreateOnly(this.path(input.identity.attemptId, "reserved"), canonicalJson(record), true);
    return record;
  }
  public async terminal(input: { readonly identity: AttemptIdentity;
    readonly reservation: ReservationRecord; readonly signedResult: unknown;
    readonly state: "terminal_failure" | "terminal_success" }): Promise<TerminalRecord> {
    const signedResult = nodeCampaignAuthentication.verify(input.signedResult, this.resultAuthority.keyId,
      this.resultAuthority.publicKeyPem, "provider result");
    const reservation = await this.requireReservation(input.identity.attemptId);
    if (canonicalJson(reservation) !== canonicalJson(input.reservation)) {
      throw new Error("terminal result reservation is stale");
    }
    const result = decodeProviderTerminalPayload(signedResult.payload);
    if (canonicalJson(result) !== canonicalJson(providerTerminalBinding(reservation, input.state,
      result.resultEnvelopeDigestSha256))) {
      throw new Error("terminal result does not bind request, release, spend, and call identity");
    }
    const record = Object.freeze({ attemptId: input.identity.attemptId,
      reservationSha256: sha256(reservation), resultDigestSha256:
      digest(result.resultEnvelopeDigestSha256, "terminal result digest"), schemaVersion:
      "meeting_knowledge.semantic_quality_provider_terminal.v2" as const, signedResult,
      state: input.state });
    await writeCreateOnly(this.path(input.identity.attemptId, "terminal"), canonicalJson(record), true);
    return record;
  }
  public async recovered(input: { readonly binding: ProviderAuthorityBinding;
    readonly identity: AttemptIdentity; readonly requestDigestSha256: string }):
  Promise<JournalRecovery> {
    const terminal = await readOptional(this.path(input.identity.attemptId, "terminal"));
    if (terminal !== null) {
      const record = decodeTerminal(terminal); const reservation = await this.requireReservation(
        input.identity.attemptId);
      if (record.attemptId !== input.identity.attemptId || record.reservationSha256 !==
        sha256(reservation)) {throw new Error("terminal membership is corrupt");}
      const signed = nodeCampaignAuthentication.verify<ProviderTerminalPayload>(record.signedResult,
        this.resultAuthority.keyId, this.resultAuthority.publicKeyPem, "provider result");
      if (canonicalJson(decodeProviderTerminalPayload(signed.payload)) !== canonicalJson(
        providerTerminalBinding(reservation, record.state, record.resultDigestSha256))) {
        throw new Error("recovered terminal is foreign to its exact reservation");
      }
      assertRecoveredBinding(input, reservation);
      return Object.freeze({ state: record.state, terminal: record });
    }
    const raw = await readOptional(this.path(input.identity.attemptId, "reserved"));
    if (raw === null) {return Object.freeze({ state: "never_reserved" });}
    const reservation = decodeReservation(raw); assertRecoveredBinding(input, reservation);
    return Object.freeze({ reservation, state: "provider_reserved" });
  }
  public async recoveredState(identity: AttemptIdentity): Promise<JournalState> {
    const raw = await readOptional(this.path(identity.attemptId, "reserved"));
    if (raw === null) {
      const terminal = await readOptional(this.path(identity.attemptId, "terminal"));
      if (terminal !== null) {throw new Error("provider terminal lacks a durable reservation");}
      return "never_reserved";
    }
    const reservation = decodeReservation(raw); const recovered = await this.recovered({ binding:
      reservation, identity, requestDigestSha256: reservation.requestDigestSha256 });
    return recovered.state === "provider_reserved" ? "outcome_unknown" : recovered.state;
  }
  private async requireReservation(attemptId: string): Promise<ReservationRecord> {
    const value = await readOptional(this.path(attemptId, "reserved"));
    if (value === null) {throw new Error("provider terminal lacks a durable reservation");}
    return decodeReservation(value);
  }
  private path(attemptId: string, kind: "reserved" | "terminal") {
    return join(this.root, attemptId, `${kind}.json`);
  }
}

/** Filesystem/AES implementation kept outside application orchestration. */
export class CampaignEncryptedArtifactStore {
  private consumedBytes = 0; private readonly root: string;
  public constructor(root: string, private readonly maximumCampaignBytes: number) {
    if (!isAbsolute(root) || root.includes("\0") || !Number.isSafeInteger(maximumCampaignBytes) ||
      maximumCampaignBytes < 1) {throw new Error("encrypted artifact store configuration is invalid");}
    this.root = resolve(root);
  }
  public async seal(input: { readonly artifactKind: EncryptedArtifactKind;
    readonly campaignRootSha256: string; readonly identity: AttemptIdentity;
    readonly key: Uint8Array; readonly keyId: string; readonly plaintext: Uint8Array;
    readonly releaseRootSha256: string }): Promise<ArtifactReceipt> {
    if (input.key.byteLength !== 32 || input.plaintext.byteLength < 1) {
      throw new Error("artifact encryption input is invalid");
    }
    safeId(input.keyId, "artifact key ID"); const plaintextSha256 = createHash("sha256")
      .update(input.plaintext).digest("hex");
    const aad = { artifactKind: input.artifactKind, attemptId: input.identity.attemptId,
      callOrdinal: input.identity.callOrdinal, campaignRootSha256: input.campaignRootSha256,
      keyId: input.keyId, plaintextSha256, questionDigestSha256:
      input.identity.questionDigestSha256, questionId: input.identity.questionId,
      releaseRootSha256: input.releaseRootSha256, repetition: input.identity.repetition,
      schemaVersion: "meeting_knowledge.semantic_quality_artifact_aad.v2" };
    digest(input.campaignRootSha256, "campaign root"); digest(input.releaseRootSha256,
      "release root"); const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm",
      input.key, nonce); cipher.setAAD(Buffer.from(canonicalJson(aad))); const ciphertext =
      Buffer.concat([cipher.update(input.plaintext), cipher.final()]); const envelope = { aad,
      algorithm: "A256GCM", ciphertextBase64: ciphertext.toString("base64"), nonceBase64:
      nonce.toString("base64"), tagBase64: cipher.getAuthTag().toString("base64") };
    const bytes = Buffer.from(canonicalJson(envelope));
    if (this.consumedBytes + bytes.byteLength > this.maximumCampaignBytes) {
      throw new Error("campaign encrypted byte ceiling exceeded");
    }
    const envelopeSha256 = sha256(bytes); await writeCreateOnly(join(this.root,
      `${envelopeSha256}.enc.json`), bytes); this.consumedBytes += bytes.byteLength;
    return Object.freeze({ aadSha256: sha256(aad), artifactKind: input.artifactKind,
      attemptId: input.identity.attemptId, envelopeSha256, keyId: input.keyId,
      plaintextBytes: input.plaintext.byteLength, plaintextSha256, storedBytes: bytes.byteLength });
  }
}

function decodeReservation(value: unknown): ReservationRecord {
  const record = exactRecord(value, ["attemptId", "callKind", "callOrdinal", "campaignRootSha256",
    "predecessorResultDigestSha256", "questionDigestSha256", "questionId", "releaseRootSha256",
    "repetition", "requestDigestSha256", "schemaVersion", "spendReceiptSha256",
    "spendReservationSha256", "state"], "reservation");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_provider_reservation.v2" ||
    record.state !== "provider_reserved") {throw new Error("reservation schema or state is invalid");}
  return record as unknown as ReservationRecord;
}
function decodeTerminal(value: unknown): TerminalRecord {
  const record = exactRecord(value, ["attemptId", "reservationSha256", "resultDigestSha256",
    "schemaVersion", "signedResult", "state"], "terminal result") as unknown as TerminalRecord;
  if (!["terminal_failure", "terminal_success"].includes(record.state)) {
    throw new Error("terminal state is invalid");
  } return record;
}
function decodeProviderTerminalPayload(value: unknown): ProviderTerminalPayload {
  return exactRecord(value, ["attemptId", "callKind", "callOrdinal", "campaignRootSha256",
    "predecessorResultDigestSha256", "questionDigestSha256", "questionId", "releaseRootSha256",
    "repetition", "requestDigestSha256", "resultEnvelopeDigestSha256", "spendReceiptSha256",
    "spendReservationSha256", "state"], "provider result payload") as unknown as ProviderTerminalPayload;
}
function providerTerminalBinding(reservation: ReservationRecord,
  state: "terminal_failure" | "terminal_success", resultEnvelopeDigestSha256: string):
ProviderTerminalPayload {return Object.freeze({ attemptId: reservation.attemptId, callKind:
  reservation.callKind, callOrdinal: reservation.callOrdinal, campaignRootSha256:
  reservation.campaignRootSha256, predecessorResultDigestSha256:
  reservation.predecessorResultDigestSha256, questionDigestSha256:
  reservation.questionDigestSha256, questionId: reservation.questionId, releaseRootSha256:
  reservation.releaseRootSha256, repetition: reservation.repetition, requestDigestSha256:
  reservation.requestDigestSha256, resultEnvelopeDigestSha256, spendReceiptSha256:
  reservation.spendReceiptSha256, spendReservationSha256: reservation.spendReservationSha256,
  state });}
function assertRecoveredBinding(input: { readonly binding: ProviderAuthorityBinding;
  readonly identity: AttemptIdentity; readonly requestDigestSha256: string }, value:
  ReservationRecord): void {if (canonicalJson({ ...input.identity, campaignRootSha256:
    input.binding.campaignRootSha256, predecessorResultDigestSha256:
    input.binding.predecessorResultDigestSha256, releaseRootSha256: input.binding.releaseRootSha256,
    requestDigestSha256: input.requestDigestSha256, spendReservationSha256:
    input.binding.spendReservationSha256 }) !== canonicalJson({ attemptId: value.attemptId,
    callKind: value.callKind, callOrdinal: value.callOrdinal, campaignRootSha256:
    value.campaignRootSha256, predecessorResultDigestSha256: value.predecessorResultDigestSha256,
    questionDigestSha256: value.questionDigestSha256, questionId: value.questionId,
    releaseRootSha256: value.releaseRootSha256, repetition: value.repetition,
    requestDigestSha256: value.requestDigestSha256, spendReservationSha256:
    value.spendReservationSha256 })) {throw new Error("reservation is foreign to exact authority");}}
async function writeCreateOnly(path: string, bytes: string | Uint8Array,
  rejectExisting = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const info = await stat(dirname(path));
  if (!info.isDirectory()) {throw new Error("durable path is not a directory");}
  const handle = await open(path, "wx", 0o600).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}
    if (!(await readFile(path)).equals(Buffer.from(bytes))) {throw new Error("create-only conflict");}
    if (rejectExisting) {throw new Error("exact attempt is already reserved or terminal");}
    return null;}); if (handle === null) {return;} try {await handle.writeFile(bytes);
    await handle.sync();} finally {await handle.close();} const directory = await open(dirname(path),
      "r"); try {await directory.sync();} finally {await directory.close();}
}
async function readOptional(path: string): Promise<unknown> {try {return JSON.parse((await readFile(
  path)).toString("utf8")) as unknown;} catch (error) {if ((error as NodeJS.ErrnoException).code ===
    "ENOENT") {return null;} throw error;}}
