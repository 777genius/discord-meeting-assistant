import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, digest, exactRecord } from "./canonical.js";
import { SemanticQualityV4EncryptedArtifactStore } from
  "./canonical-execution-evidence-store.js";
import type { SemanticQualityV4DurabilityFaults } from
  "./canonical-execution-evidence-store.js";
import { validateSemanticQualityV4ArtifactReceipt,
  type SemanticQualityV4ArtifactKind, type SemanticQualityV4ArtifactReceipt } from
  "./canonical-execution-artifact-validation.js";
import type { QualificationCreateOnlyJournalPort, QualificationEncryptedAuditPort } from
  "./production-canonical-question-chain.js";
import { decodeQualificationQuestionOutcome, type QualificationQuestionOutcome } from
  "./execute-admitted-qualification-question.js";

type Phase = "answer" | "retrieval";

/** Durable adapters shared by the scheduler and the one canonical execution chain. */
export function createProductionCanonicalExecutionEvidence(input: {
  readonly answerJournalRoot: string;
  readonly artifactKey: Uint8Array;
  readonly artifactKeyId: string;
  readonly artifactRoot: string;
  readonly attemptId: string;
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3;
  readonly retrievalJournalRoot: string;
  readonly rootBindingSha256: string;
  readonly durabilityFaults?: SemanticQualityV4DurabilityFaults;
}): { readonly audit: QualificationEncryptedAuditPort;
  readonly journal: QualificationCreateOnlyJournalPort } {
  assertBinding(input);
  const journals: Readonly<Record<Phase, CanonicalPhaseJournal>> = Object.freeze({
    answer: new CanonicalPhaseJournal(input.answerJournalRoot, input, "answer"),
    retrieval: new CanonicalPhaseJournal(input.retrievalJournalRoot, input, "retrieval"),
  });
  const artifacts = new SemanticQualityV4EncryptedArtifactStore(input.artifactRoot,
    input.durabilityFaults);
  const journal: QualificationCreateOnlyJournalPort = Object.freeze({
    reserve: async ({ attemptId, payloadSha256, phase }: Parameters<
      QualificationCreateOnlyJournalPort["reserve"]>[0]) => {
      assertAttempt(attemptId, input.attemptId);
      await journals[phase].reserve(payloadSha256);
    },
    terminal: async ({ attemptId, payloadSha256, phase, state }: Parameters<
      QualificationCreateOnlyJournalPort["terminal"]>[0]) => {
      assertAttempt(attemptId, input.attemptId);
      await journals[phase].terminal(payloadSha256, state);
    },
  });
  const audit: QualificationEncryptedAuditPort = Object.freeze({
    seal: async ({ attemptId, kind, plaintext }: Parameters<
      QualificationEncryptedAuditPort["seal"]>[0]) => {
      assertAttempt(attemptId, input.attemptId);
      const receipt = await artifacts.sealCreateOnly({ artifactKind: kind,
        attemptId, key: input.artifactKey, keyId: input.artifactKeyId, plaintext,
        rootBindingSha256: input.rootBindingSha256 });
      const receiptDirectory = join(resolve(input.artifactRoot), "receipts", attemptId);
      await ensureDirectory(receiptDirectory, input.durabilityFaults);
      await writeCreateOnly(join(receiptDirectory, `${kind}.json`), canonicalJson(receipt),
        input.durabilityFaults);
      if (kind === "answer_normalized_outcome") {
        const outcomeDirectory = join(resolve(input.artifactRoot), "outcomes");
        await ensureDirectory(outcomeDirectory, input.durabilityFaults);
        await writeCreateOnly(join(outcomeDirectory, `${attemptId}.json`), canonicalJson({
          attemptId, envelopeSha256: receipt.envelopeSha256,
          plaintextSha256: receipt.plaintextSha256, rootBindingSha256: input.rootBindingSha256,
          schemaVersion: "meeting_knowledge.canonical_quality_outcome_pointer.v1" }),
        input.durabilityFaults);
      }
    },
  });
  return Object.freeze({ audit, journal });
}

export async function recoverProductionCanonicalOutcome(input: {
  readonly answerJournalRoot: string; readonly artifactKey: Uint8Array;
  readonly artifactKeyId: string; readonly artifactRoot: string; readonly attemptId: string;
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3; readonly retrievalJournalRoot: string;
  readonly rootBindingSha256: string;
}): Promise<QualificationQuestionOutcome | "outcome_unknown" | null> {
  assertBinding(input);
  const pointerPath = join(resolve(input.artifactRoot), "outcomes", `${input.attemptId}.json`);
  const pointerBytes = await readOptionalBounded(pointerPath, 16_384,
    "canonical normalized outcome pointer");
  if (pointerBytes !== null) {
    const pointer = exactRecord(JSON.parse(Buffer.from(pointerBytes).toString("utf8")) as unknown,
      ["attemptId", "envelopeSha256", "plaintextSha256", "rootBindingSha256", "schemaVersion"],
      "canonical normalized outcome pointer");
    if (
      pointer.attemptId !== input.attemptId || pointer.rootBindingSha256 !== input.rootBindingSha256 ||
      pointer.schemaVersion !== "meeting_knowledge.canonical_quality_outcome_pointer.v1" ||
      typeof pointer.envelopeSha256 !== "string" || typeof pointer.plaintextSha256 !== "string") {
      throw new Error("canonical normalized outcome pointer is invalid");
    }
    const opened = await readProductionCanonicalArtifact({ artifactKey: input.artifactKey,
      artifactKeyId: input.artifactKeyId, artifactRoot: input.artifactRoot, attemptId: input.attemptId,
      kind: "answer_normalized_outcome", rootBindingSha256: input.rootBindingSha256 });
    if (canonicalJson(pointer) !== canonicalJson({ attemptId: opened.receipt.attemptId,
      envelopeSha256: opened.receipt.envelopeSha256,
      plaintextSha256: opened.receipt.plaintextSha256,
      rootBindingSha256: opened.receipt.rootBindingSha256,
      schemaVersion: "meeting_knowledge.canonical_quality_outcome_pointer.v1" })) {
      throw new Error("canonical normalized outcome pointer is not receipt-bound");
    }
    const plaintext = opened.plaintext;
    return decodeQualificationQuestionOutcome(JSON.parse(Buffer.from(plaintext).toString("utf8")));
  }
  for (const root of [input.answerJournalRoot, input.retrievalJournalRoot]) {
    if (await exists(join(resolve(root), input.attemptId, "provider_reserved.json"))) {
      return "outcome_unknown";
    }
  }
  return null;
}

/** Reads the mandatory deterministic receipt index and authenticates its exact envelope bytes. */
export async function readProductionCanonicalArtifact(input: { readonly artifactKey: Uint8Array;
  readonly artifactKeyId: string; readonly artifactRoot: string; readonly attemptId: string;
  readonly kind: SemanticQualityV4ArtifactKind; readonly rootBindingSha256: string }):
Promise<{ readonly plaintext: Uint8Array; readonly receipt: SemanticQualityV4ArtifactReceipt }> {
  if (!isAbsolute(input.artifactRoot) || input.artifactRoot.includes("\0")) {
    throw new Error("canonical artifact root is invalid");
  }
  if (!/^sqv4-[a-f0-9]{64}$/u.test(input.attemptId)) {
    throw new Error("canonical artifact attempt ID is invalid");
  }
  if (!isArtifactKind(input.kind)) {throw new Error("canonical artifact kind is invalid");}
  digest(input.rootBindingSha256, "canonical artifact root binding");
  const receiptPath = join(resolve(input.artifactRoot), "receipts", input.attemptId,
    `${input.kind}.json`);
  const receiptBytes = await readBounded(receiptPath, 16_384, "canonical artifact receipt index");
  const receipt = validateSemanticQualityV4ArtifactReceipt(JSON.parse(
    Buffer.from(receiptBytes).toString("utf8")) as unknown);
  if (receipt.attemptId !== input.attemptId || receipt.artifactKind !== input.kind ||
    receipt.rootBindingSha256 !== input.rootBindingSha256) {
    throw new Error("canonical artifact receipt index is foreign or substituted");
  }
  const store = new SemanticQualityV4EncryptedArtifactStore(input.artifactRoot);
  const plaintext = await store.openReceipt({ expectedKeyId: input.artifactKeyId,
    key: input.artifactKey, receipt });
  return Object.freeze({ plaintext, receipt });
}

class CanonicalPhaseJournal {
  readonly #directory: string;
  readonly #binding: { readonly attemptId: string; readonly phase: Phase;
    readonly questionId: string; readonly repetition: 1 | 2 | 3;
    readonly rootBindingSha256: string };
  public constructor(root: string, input: { readonly attemptId: string;
    readonly questionId: string; readonly repetition: 1 | 2 | 3;
    readonly rootBindingSha256: string }, phase: Phase) {
    if (!isAbsolute(root) || root.includes("\0")) {
      throw new Error("canonical execution journal root is invalid");
    }
    this.#directory = join(resolve(root), input.attemptId);
    this.#binding = Object.freeze({ attemptId: input.attemptId,
      phase: phase,
      questionId: input.questionId, repetition: input.repetition,
      rootBindingSha256: input.rootBindingSha256 });
  }
  public async reserve(payloadSha256: string): Promise<void> {
    digest(payloadSha256, "canonical reserved payload");
    await ensureDirectory(this.#directory);
    if (await exists(join(this.#directory, "terminal.json")) ||
      await exists(join(this.#directory, "provider_reserved.json"))) {
      throw new Error("canonical provider effect is already reserved and cannot be retried");
    }
    await writeCreateOnly(join(this.#directory, "provider_reserved.json"), canonicalJson({
      ...this.#binding, reservedPayloadSha256: payloadSha256,
      schemaVersion: "meeting_knowledge.canonical_quality_reservation.v1",
      state: "provider_reserved" }));
  }
  public async terminal(payloadSha256: string,
    state: "failed" | "outcome_unknown" | "succeeded"): Promise<void> {
    digest(payloadSha256, "canonical terminal payload");
    const reservationPath = join(this.#directory, "provider_reserved.json");
    const reservation = JSON.parse(await readFile(reservationPath, "utf8")) as
      Record<string, unknown>;
    if (canonicalJson({ attemptId: reservation.attemptId, phase: reservation.phase,
      questionId: reservation.questionId, repetition: reservation.repetition,
      rootBindingSha256: reservation.rootBindingSha256 }) !== canonicalJson(this.#binding) ||
      reservation.state !== "provider_reserved") {
      throw new Error("canonical provider terminal lacks its exact durable reservation");
    }
    await writeCreateOnly(join(this.#directory, "terminal.json"), canonicalJson({
      ...this.#binding, reservedPayloadSha256: reservation.reservedPayloadSha256,
      schemaVersion: "meeting_knowledge.canonical_quality_terminal.v1", state,
      terminalPayloadSha256: payloadSha256 }));
  }
}

function assertBinding(input: { readonly artifactKey: Uint8Array; readonly attemptId: string;
  readonly questionId: string; readonly repetition: number; readonly rootBindingSha256: string }) {
  if (input.artifactKey.byteLength !== 32 || !/^sqv4-[a-f0-9]{64}$/u.test(input.attemptId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.questionId) ||
    ![1, 2, 3].includes(input.repetition)) {
    throw new Error("canonical execution evidence binding is invalid");
  }
  digest(input.rootBindingSha256, "canonical execution root binding");
}

function assertAttempt(actual: string, expected: string): void {
  if (actual !== expected) {throw new Error("canonical execution attempt is substituted");}
}

async function exists(path: string): Promise<boolean> {
  try {await stat(path); return true;} catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {return false;} throw error;
  }
}

async function ensureDirectory(path: string, faults: SemanticQualityV4DurabilityFaults = {}):
Promise<void> {
  await ensureDurableDirectory(path, faults);
  const metadata = await stat(path);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
    throw new Error("canonical evidence directory permissions are not private");
  }
  const handle = await open(path, "r");
  try {await handle.sync();} finally {await handle.close();}
}

async function ensureDurableDirectory(path: string,
  faults: SemanticQualityV4DurabilityFaults): Promise<void> {
  const absolute = resolve(path);
  const parent = resolve(absolute, "..");
  if (parent !== absolute) {await ensureDurableDirectory(parent, faults);}
  let created = false;
  try {await mkdir(absolute, { mode: 0o700 }); created = true;}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await stat(absolute)).isDirectory()) {
      throw error;
    }
  }
  await syncDirectory(absolute, faults);
  if (created && parent !== absolute) {await syncDirectory(parent, faults);}
}

async function syncDirectory(path: string, faults: SemanticQualityV4DurabilityFaults): Promise<void> {
  const handle = await open(path, "r");
  try {await handle.sync();} finally {await handle.close();}
  faults.afterDirectorySync?.(path);
}

async function writeCreateOnly(path: string, value: string,
  faults: SemanticQualityV4DurabilityFaults = {}): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {await handle.writeFile(value); await handle.sync(); faults.afterFileSync?.(path);}
  finally {await handle.close();}
  const directory = await open(dirname(path), "r");
  try {await directory.sync();} finally {await directory.close();}
  faults.afterDirectorySync?.(dirname(path));
}

async function readBounded(path: string, maximumBytes: number, label: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) {
      throw new Error(`${label} exceeds its byte bound`);
    }
    const size = Number(metadata.size);
    const bytes = Buffer.alloc(size);
    const { bytesRead } = await handle.read(bytes, 0, size, 0);
    const { bytesRead: trailingBytes } = await handle.read(Buffer.alloc(1), 0, 1, size);
    const after = await handle.stat({ bigint: true });
    if (bytesRead !== size || trailingBytes !== 0 || after.size !== metadata.size ||
      after.dev !== metadata.dev || after.ino !== metadata.ino ||
      after.mtimeNs !== metadata.mtimeNs || after.ctimeNs !== metadata.ctimeNs) {
      throw new Error(`${label} changed while being read`);
    }
    return bytes;
  } finally {await handle.close();}
}

async function readOptionalBounded(path: string, maximumBytes: number,
  label: string): Promise<Uint8Array | null> {
  try {return await readBounded(path, maximumBytes, label);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {return null;}
    throw error;
  }
}

function isArtifactKind(value: unknown): value is SemanticQualityV4ArtifactKind {
  return ["adjudication", "answer", "answer_normalized_outcome", "answer_original_model_surface",
    "answer_original_request", "answer_original_response", "answer_repair_model_surface",
    "answer_repair_request", "answer_repair_response", "capability_request", "capability_response",
    "evidence", "original_model_input", "original_provider_request", "original_provider_response",
    "repair_model_input", "repair_provider_request", "repair_provider_response", "raw_outcome",
    "response_runtime", "retrieval_request", "retrieval_response", "retrieval_observation",
    "selected_canonical_turns"].includes(value as string);
}
