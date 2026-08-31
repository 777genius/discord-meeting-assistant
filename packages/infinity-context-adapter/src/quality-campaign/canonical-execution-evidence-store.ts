import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalJson as canonicalIntegerJson, sha256 as canonicalSha256 } from "./canonical.js";

export type SemanticQualityV4TerminalState = "failed" | "outcome_unknown" | "succeeded";

export type SemanticQualityV4ArtifactKind = "adjudication" | "answer" | "evidence" |
  "answer_normalized_outcome" | "answer_original_model_surface" |
  "answer_original_request" | "answer_original_response" | "answer_repair_model_surface" |
  "answer_repair_request" | "answer_repair_response" |
  "original_model_input" | "original_provider_request" | "original_provider_response" |
  "repair_model_input" | "repair_provider_request" | "repair_provider_response" |
  "raw_outcome" | "response_runtime" | "retrieval_request" | "retrieval_response" |
  "selected_canonical_turns";

export interface SemanticQualityV4ArtifactReceipt {
  readonly algorithm: "A256GCM";
  readonly artifactKind: SemanticQualityV4ArtifactKind;
  readonly attemptId: string;
  readonly envelopeSha256: string;
  readonly exchangeBindingSha256?: string;
  readonly plaintextSha256: string;
  readonly rootBindingSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_artifact_receipt.v1";
  readonly sizeBytes: number;
  readonly storeIdentitySha256: string;
}

export interface SemanticQualityV4DurabilityFaults {
  afterDirectorySync?(path: string): void;
  afterFileSync?(path: string): void;
}

export interface SemanticQualityV4JournalEntry {
  readonly attemptId: string;
  readonly reservedPayloadSha256: string;
  readonly terminalPayloadSha256: string | null;
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3;
  readonly rootBindingSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_journal.v2";
  readonly state: "provider_reserved" | SemanticQualityV4TerminalState;
}

export interface SemanticQualityV4ProviderCallReservation {
  readonly attemptId: string;
  readonly callOrdinal: "original" | "repair";
  readonly purpose: string;
  readonly requestRunId: string;
  readonly rootBindingSha256: string;
  readonly runtimeProfile: Readonly<Record<string, number | string>>;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_call_reservation.v1";
}

const digestPattern = /^[a-f0-9]{64}$/u;
const safeQuestionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function semanticQualityV4AttemptId(input: {
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3;
  readonly rootBindingSha256: string;
}): string {
  assertAttemptInput(input);
  return `sqv4-${canonicalSha256({
    questionId: input.questionId,
    repetition: input.repetition,
    rootBindingSha256: input.rootBindingSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_attempt.v1",
  })}`;
}

/**
 * Create-only two-entry journal. A reservation is durable before the caller may
 * cross a provider boundary; exactly one terminal file may subsequently exist.
 */
export class SemanticQualityV4CreateOnlyJournal {
  private readonly root: string;

  public constructor(root: string, private readonly faults: SemanticQualityV4DurabilityFaults = {}) {
    if (!resolve(root).startsWith("/") || root.includes("\0")) {
      throw new Error("semantic quality V4 journal root is invalid");
    }
    this.root = resolve(root);
    productionJournals.add(this);
    Object.freeze(this);
  }

  public async reserve(input: {
    readonly reservedPayloadSha256: string;
    readonly questionId: string;
    readonly repetition: 1 | 2 | 3;
    readonly rootBindingSha256: string;
  }): Promise<SemanticQualityV4JournalEntry> {
    const entry = journalEntry({ ...input, state: "provider_reserved",
      terminalPayloadSha256: null });
    const directory = await this.attemptDirectory(entry.attemptId);
    await writeCreateOnly(join(directory, "provider_reserved.json"), canonicalIntegerJson(entry),
      this.faults);
    return entry;
  }

  public async reserveProviderCall(
    input: Omit<SemanticQualityV4ProviderCallReservation, "schemaVersion">,
  ): Promise<SemanticQualityV4ProviderCallReservation> {
    if (!/^sqv4-[a-f0-9]{64}$/u.test(input.attemptId) ||
      !digestPattern.test(input.rootBindingSha256) ||
      !safeQuestionIdPattern.test(input.requestRunId) || input.purpose.trim() === "" ||
      Object.keys(input.runtimeProfile).length !== 5 ||
      Object.values(input.runtimeProfile).some((value) =>
        typeof value === "string" ? value.trim() === "" : !Number.isSafeInteger(value))) {
      throw new Error("semantic quality V4 provider call reservation is invalid");
    }
    const reservation = Object.freeze({ ...input,
      schemaVersion: "meeting_knowledge.semantic_quality_provider_call_reservation.v1" as const });
    const directory = await this.attemptDirectory(input.attemptId);
    await writeCreateOnly(join(directory, `provider_${input.callOrdinal}_reserved.json`),
      canonicalIntegerJson(reservation), this.faults);
    return reservation;
  }

  public async terminal(input: {
    readonly reservedPayloadSha256: string;
    readonly terminalPayloadSha256: string;
    readonly questionId: string;
    readonly repetition: 1 | 2 | 3;
    readonly rootBindingSha256: string;
    readonly state: SemanticQualityV4TerminalState;
  }): Promise<SemanticQualityV4JournalEntry> {
    const entry = journalEntry(input);
    const directory = await this.attemptDirectory(entry.attemptId);
    await requireExactReservation(join(directory, "provider_reserved.json"), entry);
    await writeCreateOnly(join(directory, "terminal.json"), canonicalIntegerJson(entry), this.faults);
    return entry;
  }

  public async state(input: {
    readonly questionId: string;
    readonly repetition: 1 | 2 | 3;
    readonly rootBindingSha256: string;
  }): Promise<"never_reserved" | "provider_reserved" | SemanticQualityV4TerminalState> {
    const attemptId = semanticQualityV4AttemptId(input);
    const directory = join(this.root, attemptId);
    const terminal = await readOptionalJson(join(directory, "terminal.json"));
    if (terminal !== null) {
      const entry = decodeJournalEntry(terminal);
      if (entry.attemptId !== attemptId || entry.state === "provider_reserved") {
        throw new Error("semantic quality V4 terminal journal entry is invalid");
      }
      return entry.state;
    }
    const reservation = await readOptionalJson(join(directory, "provider_reserved.json"));
    if (reservation === null) {return "never_reserved";}
    const entry = decodeJournalEntry(reservation);
    if (entry.attemptId !== attemptId || entry.state !== "provider_reserved") {
      throw new Error("semantic quality V4 reservation journal entry is invalid");
    }
    // A surviving reservation with no authenticated terminal envelope is the
    // process-crash window. Whether bytes crossed the socket is unknowable, so
    // reopening must never present it as resumable or merely pending.
    return "outcome_unknown";
  }

  public async resumable(input: {
    readonly questionId: string;
    readonly repetition: 1 | 2 | 3;
    readonly rootBindingSha256: string;
  }): Promise<boolean> {
    return await this.state(input) === "never_reserved";
  }

  private async attemptDirectory(attemptId: string): Promise<string> {
    await ensureDurableDirectory(this.root, this.faults);
    const directory = join(this.root, attemptId);
    await ensureDurableDirectory(directory, this.faults);
    return directory;
  }
}

const productionJournals = new WeakSet<object>();

export function assertSemanticQualityV4ProductionJournal(value: unknown):
asserts value is SemanticQualityV4CreateOnlyJournal {
  if (typeof value !== "object" || value === null || !productionJournals.has(value)) {
    throw new Error("semantic quality V4 journal was not constructed by its evidence module");
  }
}

/** Stores caller-encrypted private bytes without interpreting or logging them. */
export class SemanticQualityV4EncryptedArtifactStore {
  private readonly root: string;
  private readonly storeIdentitySha256: string;

  public constructor(root: string, private readonly faults: SemanticQualityV4DurabilityFaults = {}) {
    this.root = resolve(root);
    if (!this.root.startsWith("/") || root.includes("\0")) {
      throw new Error("semantic quality V4 artifact root is invalid");
    }
    this.storeIdentitySha256 = canonicalSha256({ algorithm: "A256GCM", root: this.root,
      schemaVersion: "meeting_knowledge.semantic_quality_artifact_store.v1" });
    productionArtifactStores.add(this);
    Object.freeze(this);
  }

  public async sealCreateOnly(input: {
    readonly artifactKind: SemanticQualityV4ArtifactKind;
    readonly attemptId: string;
    readonly key: Uint8Array;
    readonly keyId: string;
    readonly plaintext: Uint8Array;
    readonly rootBindingSha256: string;
    readonly exchangeBindingSha256?: string;
  }): Promise<SemanticQualityV4ArtifactReceipt> {
    if (input.key.byteLength !== 32 || !safeQuestionIdPattern.test(input.keyId) ||
      !/^sqv4-[a-f0-9]{64}$/u.test(input.attemptId) ||
      !digestPattern.test(input.rootBindingSha256) || input.plaintext.byteLength < 1 ||
      (input.exchangeBindingSha256 !== undefined &&
        !digestPattern.test(input.exchangeBindingSha256))) {
      throw new Error("semantic quality V4 encrypted artifact binding is invalid");
    }
    const plaintextSha256 = createHash("sha256").update(input.plaintext).digest("hex");
    const nonce = randomBytes(12);
    const binding = { artifactKind: input.artifactKind, attemptId: input.attemptId,
      keyId: input.keyId, plaintextSha256, rootBindingSha256: input.rootBindingSha256,
      ...(input.exchangeBindingSha256 === undefined ? {} : {
        exchangeBindingSha256: input.exchangeBindingSha256 }),
      schemaVersion: "meeting_knowledge.semantic_quality_artifact_envelope.v1" };
    const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
    cipher.setAAD(Buffer.from(canonicalIntegerJson(binding), "utf8"));
    const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
    const envelope = { ...binding, algorithm: "A256GCM" as const,
      ciphertextBase64: ciphertext.toString("base64"), nonceBase64: nonce.toString("base64"),
      tagBase64: cipher.getAuthTag().toString("base64") };
    const bytes = Buffer.from(canonicalIntegerJson(envelope), "utf8");
    const envelopeSha256 = createHash("sha256").update(bytes).digest("hex");
    await ensureDurableDirectory(this.root, this.faults);
    await writeCreateOnly(join(this.root, `${envelopeSha256}.enc.json`), bytes, this.faults);
    return Object.freeze({ algorithm: "A256GCM", artifactKind: input.artifactKind,
      attemptId: input.attemptId, envelopeSha256, plaintextSha256,
      ...(input.exchangeBindingSha256 === undefined ? {} : {
        exchangeBindingSha256: input.exchangeBindingSha256 }),
      rootBindingSha256: input.rootBindingSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_artifact_receipt.v1",
      sizeBytes: bytes.byteLength, storeIdentitySha256: this.storeIdentitySha256 });
  }

  public async open(input: { readonly envelopeSha256: string; readonly key: Uint8Array }):
  Promise<Uint8Array> {
    if (!digestPattern.test(input.envelopeSha256) || input.key.byteLength !== 32) {
      throw new Error("semantic quality V4 encrypted artifact binding is invalid");
    }
    const bytes = await readFile(join(this.root, `${input.envelopeSha256}.enc.json`));
    if (createHash("sha256").update(bytes).digest("hex") !== input.envelopeSha256) {
      throw new Error("semantic quality V4 artifact envelope digest is invalid");
    }
    const envelope = decodeArtifactEnvelope(JSON.parse(bytes.toString("utf8")) as unknown);
    const { algorithm: _algorithm, ciphertextBase64, nonceBase64, tagBase64, ...binding } = envelope;
    try {
      const decipher = createDecipheriv("aes-256-gcm", input.key, Buffer.from(nonceBase64, "base64"));
      decipher.setAAD(Buffer.from(canonicalIntegerJson(binding), "utf8"));
      decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextBase64, "base64")),
        decipher.final()]);
      if (createHash("sha256").update(plaintext).digest("hex") !== binding.plaintextSha256) {
        throw new Error("digest");
      }
      return plaintext;
    } catch {
      throw new Error("semantic quality V4 artifact authentication failed");
    }
  }

  public async verifyReceipt(input: { readonly key: Uint8Array;
    readonly receipt: SemanticQualityV4ArtifactReceipt }): Promise<void> {
    const receipt = validateSemanticQualityV4ArtifactReceipt(input.receipt);
    if (receipt.storeIdentitySha256 !== this.storeIdentitySha256) {
      throw new Error("semantic quality V4 artifact receipt belongs to another store");
    }
    const plaintext = await this.open({ envelopeSha256: receipt.envelopeSha256, key: input.key });
    if (createHash("sha256").update(plaintext).digest("hex") !== receipt.plaintextSha256) {
      throw new Error("semantic quality V4 artifact receipt plaintext differs");
    }
    const envelope = decodeArtifactEnvelope(JSON.parse(await readFile(
      join(this.root, `${receipt.envelopeSha256}.enc.json`), "utf8")) as unknown);
    if (envelope.artifactKind !== receipt.artifactKind ||
      envelope.attemptId !== receipt.attemptId ||
      envelope.rootBindingSha256 !== receipt.rootBindingSha256 ||
      envelope.plaintextSha256 !== receipt.plaintextSha256 ||
      envelope.exchangeBindingSha256 !== receipt.exchangeBindingSha256) {
      throw new Error("semantic quality V4 artifact receipt is not envelope-bound");
    }
  }
}

const productionArtifactStores = new WeakSet<SemanticQualityV4EncryptedArtifactStore>();

export function assertSemanticQualityV4ProductionArtifactStore(
  store: SemanticQualityV4EncryptedArtifactStore,
): void {
  if (!productionArtifactStores.has(store)) {
    throw new Error("semantic quality V4 requires the branded A256GCM artifact store");
  }
}

function journalEntry(input: {
  readonly reservedPayloadSha256: string;
  readonly terminalPayloadSha256: string | null;
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3;
  readonly rootBindingSha256: string;
  readonly state: "provider_reserved" | SemanticQualityV4TerminalState;
}): SemanticQualityV4JournalEntry {
  assertAttemptInput(input);
  if (!digestPattern.test(input.reservedPayloadSha256) ||
    (input.state === "provider_reserved" ? input.terminalPayloadSha256 !== null :
      input.terminalPayloadSha256 === null || !digestPattern.test(input.terminalPayloadSha256))) {
    throw new Error("semantic quality V4 journal payload digest is invalid");
  }
  return Object.freeze({
    attemptId: semanticQualityV4AttemptId(input),
    reservedPayloadSha256: input.reservedPayloadSha256,
    questionId: input.questionId,
    repetition: input.repetition,
    rootBindingSha256: input.rootBindingSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_journal.v2",
    state: input.state,
    terminalPayloadSha256: input.terminalPayloadSha256,
  });
}

function assertAttemptInput(input: {
  readonly questionId: string;
  readonly repetition: number;
  readonly rootBindingSha256: string;
}): void {
  if (!safeQuestionIdPattern.test(input.questionId) ||
    (input.repetition !== 1 && input.repetition !== 2 && input.repetition !== 3) ||
    !digestPattern.test(input.rootBindingSha256)) {
    throw new Error("semantic quality V4 attempt binding is invalid");
  }
}

async function writeCreateOnly(path: string, value: string | Uint8Array,
  faults: SemanticQualityV4DurabilityFaults): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
    faults.afterFileSync?.(path);
  } finally {
    await file.close();
  }
  await syncDirectory(resolve(path, ".."), faults);
}

async function requireExactReservation(
  path: string,
  terminal: SemanticQualityV4JournalEntry,
): Promise<void> {
  const reservation = decodeJournalEntry(JSON.parse(await readFile(path, "utf8")) as unknown);
  if (reservation.state !== "provider_reserved" ||
    reservation.attemptId !== terminal.attemptId ||
    reservation.questionId !== terminal.questionId ||
    reservation.repetition !== terminal.repetition ||
    reservation.rootBindingSha256 !== terminal.rootBindingSha256 ||
    reservation.reservedPayloadSha256 !== terminal.reservedPayloadSha256) {
    throw new Error("semantic quality V4 terminal lacks its exact durable reservation");
  }
}

function decodeJournalEntry(value: unknown): SemanticQualityV4JournalEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("semantic quality V4 journal entry is invalid");
  }
  const entry = value as Partial<SemanticQualityV4JournalEntry>;
  if (typeof entry.attemptId !== "string" || typeof entry.reservedPayloadSha256 !== "string" ||
    typeof entry.questionId !== "string" || typeof entry.repetition !== "number" ||
    typeof entry.rootBindingSha256 !== "string" ||
    entry.schemaVersion !== "meeting_knowledge.semantic_quality_journal.v2" ||
    (entry.state !== "provider_reserved" && entry.state !== "failed" &&
      entry.state !== "outcome_unknown" && entry.state !== "succeeded") ||
    Object.keys(value).length !== 8 ||
    semanticQualityV4AttemptId({ questionId: entry.questionId,
      repetition: entry.repetition,
      rootBindingSha256: entry.rootBindingSha256 }) !== entry.attemptId ||
    !digestPattern.test(entry.reservedPayloadSha256) ||
    (entry.state === "provider_reserved" ? entry.terminalPayloadSha256 !== null :
      typeof entry.terminalPayloadSha256 !== "string" ||
      !digestPattern.test(entry.terminalPayloadSha256))) {
    throw new Error("semantic quality V4 journal entry is invalid");
  }
  return entry as SemanticQualityV4JournalEntry;
}

async function ensureDurableDirectory(path: string,
  faults: SemanticQualityV4DurabilityFaults): Promise<void> {
  const absolute = resolve(path);
  const parent = resolve(absolute, "..");
  if (parent !== absolute) {await ensureDurableDirectory(parent, faults);}
  let created = false;
  try {
    await mkdir(absolute, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}
    if (!(await stat(absolute)).isDirectory()) {throw error;}
  }
  await syncDirectory(absolute, faults);
  if (created && parent !== absolute) {await syncDirectory(parent, faults);}
}

async function syncDirectory(path: string, faults: SemanticQualityV4DurabilityFaults): Promise<void> {
  const directory = await open(path, "r");
  try {await directory.sync();} finally {await directory.close();}
  faults.afterDirectorySync?.(path);
}

function decodeArtifactEnvelope(value: unknown): {
  readonly algorithm: "A256GCM"; readonly artifactKind: string; readonly attemptId: string;
  readonly ciphertextBase64: string; readonly keyId: string; readonly nonceBase64: string;
  readonly exchangeBindingSha256?: string;
  readonly plaintextSha256: string; readonly rootBindingSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_artifact_envelope.v1";
  readonly tagBase64: string;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("semantic quality V4 artifact envelope is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = ["algorithm", "artifactKind", "attemptId", "ciphertextBase64", "keyId",
    "nonceBase64", "plaintextSha256", "rootBindingSha256", "schemaVersion", "tagBase64",
    ...(record.exchangeBindingSha256 === undefined ? [] : ["exchangeBindingSha256"])].toSorted();
  if (canonicalIntegerJson(Object.keys(record).toSorted()) !== canonicalIntegerJson(keys) ||
    record.algorithm !== "A256GCM" ||
    record.schemaVersion !== "meeting_knowledge.semantic_quality_artifact_envelope.v1" ||
    !isArtifactKind(record.artifactKind) || typeof record.attemptId !== "string" ||
    typeof record.ciphertextBase64 !== "string" || typeof record.keyId !== "string" ||
    typeof record.nonceBase64 !== "string" || typeof record.tagBase64 !== "string" ||
    typeof record.plaintextSha256 !== "string" || !digestPattern.test(record.plaintextSha256) ||
    typeof record.rootBindingSha256 !== "string" || !digestPattern.test(record.rootBindingSha256) ||
    (record.exchangeBindingSha256 !== undefined &&
      (typeof record.exchangeBindingSha256 !== "string" ||
        !digestPattern.test(record.exchangeBindingSha256)))) {
    throw new Error("semantic quality V4 artifact envelope is invalid");
  }
  return record as ReturnType<typeof decodeArtifactEnvelope>;
}

export function validateSemanticQualityV4ArtifactReceipt(
  value: unknown,
): SemanticQualityV4ArtifactReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("semantic quality V4 artifact receipt is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = ["algorithm", "artifactKind", "attemptId", "envelopeSha256", "plaintextSha256",
    "rootBindingSha256", "schemaVersion", "sizeBytes", "storeIdentitySha256",
    ...(record.exchangeBindingSha256 === undefined ? [] : ["exchangeBindingSha256"])].toSorted();
  if (canonicalIntegerJson(Object.keys(record).toSorted()) !== canonicalIntegerJson(keys) ||
    record.algorithm !== "A256GCM" ||
    record.schemaVersion !== "meeting_knowledge.semantic_quality_artifact_receipt.v1" ||
    !isArtifactKind(record.artifactKind) || typeof record.attemptId !== "string" ||
    !/^sqv4-[a-f0-9]{64}$/u.test(record.attemptId) ||
    [record.envelopeSha256, record.plaintextSha256, record.rootBindingSha256,
      record.storeIdentitySha256].some((item) => typeof item !== "string" ||
      !digestPattern.test(item)) || !Number.isSafeInteger(record.sizeBytes) ||
    (record.exchangeBindingSha256 !== undefined &&
      (typeof record.exchangeBindingSha256 !== "string" ||
        !digestPattern.test(record.exchangeBindingSha256))) ||
    (record.sizeBytes as number) < 1) {
    throw new Error("semantic quality V4 artifact receipt is invalid");
  }
  return record as unknown as SemanticQualityV4ArtifactReceipt;
}

function isArtifactKind(value: unknown): value is SemanticQualityV4ArtifactKind {
  return value === "adjudication" || value === "answer" ||
    value === "answer_normalized_outcome" || value === "answer_original_model_surface" ||
    value === "answer_original_request" || value === "answer_original_response" ||
    value === "answer_repair_model_surface" || value === "answer_repair_request" ||
    value === "answer_repair_response" || value === "evidence" ||
    value === "original_model_input" || value === "original_provider_request" ||
    value === "original_provider_response" || value === "repair_model_input" ||
    value === "repair_provider_request" || value === "repair_provider_response" ||
    value === "raw_outcome" || value === "response_runtime" || value === "retrieval_request" ||
    value === "retrieval_response" || value === "selected_canonical_turns";
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    await stat(path);
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {return null;}
    throw error;
  }
}
