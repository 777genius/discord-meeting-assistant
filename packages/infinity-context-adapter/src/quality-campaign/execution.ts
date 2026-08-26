import { createCipheriv, createHash, createPublicKey, randomBytes, verify } from "node:crypto";
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
    const payload = exactRecord(signed.payload, keys, "spend reservation payload") as unknown as
      SpendReservation;
    if (payload.repetition !== index + 1 || payload.campaignRootSha256 !==
      input.campaignRootSha256 || payload.releaseRootSha256 !== input.releaseRootSha256 ||
      payload.expiresAtEpochMs <= input.nowEpochMs || payload.maxCalls < 240 ||
      payload.maxTokens < 1 || payload.maxEncryptedBytes < 1 || payload.provider.trim() === "" ||
      payload.model !== FROZEN_ANSWER_EXECUTION.model ||
      payload.reasoning !== FROZEN_ANSWER_EXECUTION.reasoning ||
      payload.serviceTier !== FROZEN_ANSWER_EXECUTION.serviceTier ||
      ![payload.expiresAtEpochMs, payload.maxCalls, payload.maxTokens,
        payload.maxEncryptedBytes].every(Number.isSafeInteger)) {
      throw new Error("spend reservation binding is invalid");
    }
    return signed;
  }));
}

export type CallKind = "adjudicator_1" | "adjudicator_2" | "answer" | "capability" |
  "resolver" | "retrieval";
export type TerminalState = "terminal_failure" | "terminal_success" | "outcome_unknown";
export type JournalState = "never_reserved" | "provider_reserved" | TerminalState;

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
  if (![1, 2, 3].includes(input.repetition) || !Number.isSafeInteger(input.callOrdinal) ||
    input.callOrdinal < 0) {throw new Error("attempt identity is invalid");}
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

interface TerminalRecord {
  readonly attemptId: string;
  readonly reservationSha256: string;
  readonly resultDigestSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal.v2";
  readonly signedResult: SignedValue<unknown>;
  readonly state: TerminalState;
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
    readonly state: TerminalState }): Promise<TerminalRecord> {
    if (input.state === "outcome_unknown") {
      throw new Error("outcome_unknown is inferred from uncertain effect, never asserted by a provider");
    }
    const signedResult = verifyExternalSignedValue(input.signedResult, this.resultAuthority.keyId,
      this.resultAuthority.publicKeyPem, "provider result");
    const result = exactRecord(signedResult.payload, ["attemptId", "resultDigestSha256",
      "state"], "provider result payload");
    if (result.attemptId !== input.identity.attemptId || result.state !== input.state) {
      throw new Error("terminal result does not bind the stable attempt");
    }
    const reservation = await this.requireReservation(input.identity.attemptId);
    if (canonicalJson(reservation) !== canonicalJson(input.reservation)) {
      throw new Error("terminal result reservation is stale");
    }
    const record = Object.freeze({ attemptId: input.identity.attemptId,
      reservationSha256: sha256(reservation),
      resultDigestSha256: digest(result.resultDigestSha256, "terminal result digest"),
      schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal.v2" as const,
      signedResult, state: input.state });
    await writeCreateOnly(this.path(input.identity.attemptId, "terminal"), canonicalJson(record));
    return record;
  }

  /** A durable reservation without an authenticated terminal is never retryable after restart. */
  public async recoveredState(identity: AttemptIdentity): Promise<JournalState> {
    const terminal = await readOptional(this.path(identity.attemptId, "terminal"));
    if (terminal !== null) {
      const record = decodeTerminal(terminal);
      if (record.attemptId !== identity.attemptId) {throw new Error("terminal membership is corrupt");}
      verifyExternalSignedValue(record.signedResult, this.resultAuthority.keyId,
        this.resultAuthority.publicKeyPem, "provider result");
      return record.state;
    }
    const reservation = await readOptional(this.path(identity.attemptId, "reserved"));
    if (reservation === null) {return "never_reserved";}
    const decoded = decodeReservation(reservation);
    if (decoded.attemptId !== identity.attemptId || canonicalJson(identity) !== canonicalJson({
      attemptId: decoded.attemptId, callKind: decoded.callKind, callOrdinal: decoded.callOrdinal,
      questionDigestSha256: decoded.questionDigestSha256, questionId: decoded.questionId,
      repetition: decoded.repetition })) {throw new Error("reservation membership is corrupt");}
    return "outcome_unknown";
  }

  private async requireReservation(attemptId: string): Promise<ReservationRecord> {
    const value = await readOptional(this.path(attemptId, "reserved"));
    if (value === null) {throw new Error("provider terminal lacks a durable reservation");}
    return decodeReservation(value);
  }
  private path(attemptId: string, kind: "reserved" | "terminal"): string {
    return join(this.root, attemptId, `${kind}.json`);
  }
}

export type EncryptedArtifactKind = "adjudication_input" | "adjudication_result" |
  "answer_request" | "answer_response" | "capability_request" | "capability_response" |
  "evidence" | "raw_outcome" | "retrieval_request" | "retrieval_response";

export interface ArtifactReceipt {
  readonly aadSha256: string;
  readonly artifactKind: EncryptedArtifactKind;
  readonly attemptId: string;
  readonly envelopeSha256: string;
  readonly keyId: string;
  readonly plaintextBytes: number;
  readonly plaintextSha256: string;
  readonly storedBytes: number;
}

export class CampaignEncryptedArtifactStore {
  private consumedBytes = 0;
  private readonly root: string;
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
    safeId(input.keyId, "artifact key ID");
    const plaintextSha256 = createHash("sha256").update(input.plaintext).digest("hex");
    const aad = { artifactKind: input.artifactKind, attemptId: input.identity.attemptId,
      callOrdinal: input.identity.callOrdinal, campaignRootSha256: input.campaignRootSha256,
      keyId: input.keyId, plaintextSha256, questionDigestSha256:
      input.identity.questionDigestSha256, questionId: input.identity.questionId,
      releaseRootSha256: input.releaseRootSha256, repetition: input.identity.repetition,
      schemaVersion: "meeting_knowledge.semantic_quality_artifact_aad.v2" };
    digest(input.campaignRootSha256, "campaign root");
    digest(input.releaseRootSha256, "release root");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
    cipher.setAAD(Buffer.from(canonicalJson(aad)));
    const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
    const envelope = { aad, algorithm: "A256GCM", ciphertextBase64:
      ciphertext.toString("base64"), nonceBase64: nonce.toString("base64"),
      tagBase64: cipher.getAuthTag().toString("base64") };
    const bytes = Buffer.from(canonicalJson(envelope));
    if (this.consumedBytes + bytes.byteLength > this.maximumCampaignBytes) {
      throw new Error("campaign encrypted byte ceiling exceeded");
    }
    const envelopeSha256 = sha256(bytes);
    await writeCreateOnly(join(this.root, `${envelopeSha256}.enc.json`), bytes);
    this.consumedBytes += bytes.byteLength;
    return Object.freeze({ aadSha256: sha256(aad), artifactKind: input.artifactKind,
      attemptId: input.identity.attemptId, envelopeSha256, keyId: input.keyId,
      plaintextBytes: input.plaintext.byteLength, plaintextSha256,
      storedBytes: bytes.byteLength });
  }
}

export interface ProviderExchangePort {
  exchange(input: { readonly attemptId: string; readonly request: Uint8Array }): Promise<{
    readonly effect: "certain_failure" | "certain_success" | "unknown";
    readonly signedResult?: unknown;
  }>;
}

/** Exactly one call after a durable reservation. Ambiguous retrieval and answer effects are equal. */
export async function executeReservedExchange(input: { readonly campaignRootSha256: string;
  readonly identity: AttemptIdentity; readonly journal: DurableAttemptJournal;
  readonly port: ProviderExchangePort; readonly request: Uint8Array }):
Promise<JournalState> {
  const recovered = await input.journal.recoveredState(input.identity);
  if (recovered !== "never_reserved") {return recovered;}
  const reservation = await input.journal.reserve({ campaignRootSha256: input.campaignRootSha256,
    identity: input.identity, requestDigestSha256: sha256(input.request) });
  const result = await input.port.exchange({ attemptId: input.identity.attemptId,
    request: input.request });
  if (result.effect === "unknown" || result.signedResult === undefined) {return "outcome_unknown";}
  return (await input.journal.terminal({ identity: input.identity, reservation,
    signedResult: result.signedResult, state: result.effect === "certain_success" ?
      "terminal_success" : "terminal_failure" })).state;
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

async function readOptional(path: string): Promise<unknown | null> {
  try {return JSON.parse((await readFile(path)).toString("utf8")) as unknown;}
  catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") {return null;} throw error;}
}

function decodeReservation(value: unknown): ReservationRecord {
  return exactRecord(value, ["attemptId", "callKind", "callOrdinal", "campaignRootSha256",
    "questionDigestSha256", "questionId", "repetition", "requestDigestSha256",
    "schemaVersion", "state"], "reservation") as unknown as ReservationRecord;
}
function decodeTerminal(value: unknown): TerminalRecord {
  const record = exactRecord(value, ["attemptId", "reservationSha256", "resultDigestSha256",
    "schemaVersion", "signedResult", "state"], "terminal result") as unknown as TerminalRecord;
  if (!["terminal_failure", "terminal_success"].includes(record.state)) {
    throw new Error("terminal state is invalid");
  }
  return record;
}
