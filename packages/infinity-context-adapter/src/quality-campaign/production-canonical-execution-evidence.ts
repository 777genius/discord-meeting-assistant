import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, digest } from "./canonical.js";
import { SemanticQualityV4EncryptedArtifactStore,
  type SemanticQualityV4ArtifactKind } from "./canonical-execution-evidence-store.js";
import type { QualificationCreateOnlyJournalPort, QualificationEncryptedAuditPort } from
  "./production-canonical-question-chain.js";

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
}): { readonly audit: QualificationEncryptedAuditPort;
  readonly journal: QualificationCreateOnlyJournalPort } {
  assertBinding(input);
  const journals: Readonly<Record<Phase, CanonicalPhaseJournal>> = Object.freeze({
    answer: new CanonicalPhaseJournal(input.answerJournalRoot, input, "answer"),
    retrieval: new CanonicalPhaseJournal(input.retrievalJournalRoot, input, "retrieval"),
  });
  const artifacts = new SemanticQualityV4EncryptedArtifactStore(input.artifactRoot);
  const journal: QualificationCreateOnlyJournalPort = Object.freeze({
    reserve: async ({ attemptId, payloadSha256, phase }) => {
      assertAttempt(attemptId, input.attemptId);
      await journals[phase].reserve(payloadSha256);
    },
    terminal: async ({ attemptId, payloadSha256, phase, state }) => {
      assertAttempt(attemptId, input.attemptId);
      await journals[phase].terminal(payloadSha256, state);
    },
  });
  const audit: QualificationEncryptedAuditPort = Object.freeze({
    seal: async ({ attemptId, kind, plaintext }) => {
      assertAttempt(attemptId, input.attemptId);
      await artifacts.sealCreateOnly({ artifactKind: kind as SemanticQualityV4ArtifactKind,
        attemptId, key: input.artifactKey, keyId: input.artifactKeyId, plaintext,
        rootBindingSha256: input.rootBindingSha256 });
    },
  });
  return Object.freeze({ audit, journal });
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

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const handle = await open(path, "r");
  try {await handle.sync();} finally {await handle.close();}
}

async function writeCreateOnly(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {await handle.writeFile(value); await handle.sync();} finally {await handle.close();}
  const directory = await open(dirname(path), "r");
  try {await directory.sync();} finally {await directory.close();}
}
