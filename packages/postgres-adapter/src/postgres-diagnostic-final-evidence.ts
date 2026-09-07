import { createHash } from "node:crypto";
import {
  canonicalHistoricalPlannerJson,
  HISTORICAL_EVIDENCE_POLICY_VERSION,
  validateHistoricalReleaseBinding,
  type AcceptedFinalMeetingV1,
  type HistoricalOperationOptionsV1,
  type HistoricalReleaseBindingV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { FinalTranscript, type FinalTranscriptSnapshot } from "@discord-meeting/meeting-core/transcription";
import type { Pool } from "pg";

export interface DiagnosticFinalEvidenceBinding {
  readonly meetingId: string;
  readonly snapshotSha256: string;
  readonly transcriptSha256: string;
  readonly transcriptVersion: number;
  readonly roster: { readonly humans: readonly string[]; readonly automation: readonly string[] };
  readonly scopeId: string;
  readonly roomId: string;
  readonly releaseId: string;
}

const constructed = new WeakSet<object>();
export function assertConstructedPostgresDiagnosticFinalEvidence(value: unknown): asserts value is PostgresDiagnosticFinalEvidence {
  if (typeof value !== "object" || value === null || !constructed.has(value)) {
    throw new Error("diagnostic final evidence adapter is not genuine");
  }
}

/** Shared fail-closed decoder for manifests and the concrete read-only adapter. */
export function normalizeDiagnosticFinalEvidenceBinding(value: unknown): DiagnosticFinalEvidenceBinding {
  const binding = exactDiagnosticRecord(value, ["meetingId", "snapshotSha256", "transcriptSha256",
    "transcriptVersion", "roster", "scopeId", "roomId", "releaseId"]);
  const meetingId = diagnosticIdentity(binding.meetingId);
  const scopeId = diagnosticIdentity(binding.scopeId);
  const roomId = diagnosticIdentity(binding.roomId);
  const releaseId = diagnosticIdentity(binding.releaseId);
  if (!scopeId.startsWith("diagnostic:") || !roomId.startsWith("diagnostic:")) {
    throw new Error("diagnostic namespace required");
  }
  const snapshotSha256 = diagnosticHash(binding.snapshotSha256);
  const transcriptSha256 = diagnosticHash(binding.transcriptSha256);
  const transcriptVersion = binding.transcriptVersion;
  if (typeof transcriptVersion !== "number" || !Number.isSafeInteger(transcriptVersion) ||
    transcriptVersion < 1) {throw new Error("invalid frozen diagnostic binding");}
  const roster = exactDiagnosticRecord(binding.roster, ["humans", "automation"]);
  if (!Array.isArray(roster.humans) || !Array.isArray(roster.automation)) {
    throw new Error("invalid diagnostic roster");
  }
  const humans = roster.humans.map(diagnosticIdentity);
  const automation = roster.automation.map(diagnosticIdentity);
  const actors = [...humans, ...automation];
  if (humans.length === 0 || actors.length > 1_000 || new Set(actors).size !== actors.length) {
    throw new Error("invalid diagnostic roster");
  }
  return Object.freeze({meetingId, snapshotSha256, transcriptSha256, transcriptVersion,
    scopeId, roomId, releaseId,
    roster:Object.freeze({humans:Object.freeze(humans), automation:Object.freeze(automation)})});
}
function exactDiagnosticRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error("invalid diagnostic binding shape");
  }
  return value as Record<string, unknown>;
}
function diagnosticIdentity(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512 ||
    value.includes("\0")) {throw new Error("invalid diagnostic identity");}
  return value;
}
function diagnosticHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("invalid frozen diagnostic binding");
  }
  return value;
}

/** Nonqualifying legacy projection. Never admits or manufactures lifecycle authority. */
export class PostgresDiagnosticFinalEvidence {
  readonly #binding: DiagnosticFinalEvidenceBinding;
  readonly #pool: Pool;
  public constructor(pool: Pool, binding: DiagnosticFinalEvidenceBinding) {
    this.#pool = pool;
    this.#binding = normalizeDiagnosticFinalEvidenceBinding(binding);
    constructed.add(this);
    Object.freeze(this);
  }

  public async loadFrozenProjection(): Promise<AcceptedFinalMeetingV1> {
    const result = await this.#pool.query<{ revision: number; snapshot: unknown }>(
      "SELECT revision::float8 AS revision, snapshot FROM meeting_core.meetings WHERE meeting_id = $1",
      [this.#binding.meetingId],
    );
    try {
      const row = result.rows[0];
      if (row === undefined || result.rows.length !== 1) { throw new Error("invalid frozen diagnostic evidence"); }
      const bytes = canonicalHistoricalPlannerJson(row.snapshot);
      if (Buffer.byteLength(bytes) > 32_000_000 || digest(bytes) !== this.#binding.snapshotSha256) { throw new Error("invalid frozen diagnostic evidence"); }
      const snapshot = row.snapshot as { meetingId: string; revision: number; transcriptionStage: { status: string }; transcript: FinalTranscriptSnapshot };
      if (snapshot.meetingId !== this.#binding.meetingId || snapshot.revision !== row.revision ||
        !Number.isSafeInteger(row.revision) || row.revision < 0 || snapshot.transcriptionStage.status !== "succeeded" ||
        snapshot.transcript.version !== this.#binding.transcriptVersion || snapshot.transcript.turns.length > 100_000 ||
        digest(canonicalHistoricalPlannerJson(snapshot.transcript)) !== this.#binding.transcriptSha256) { throw new Error("invalid frozen diagnostic evidence"); }
      const transcript = FinalTranscript.create(snapshot.transcript);
      const humans = new Set(this.#binding.roster.humans);
      const known = new Set([...this.#binding.roster.humans, ...this.#binding.roster.automation]);
      if (transcript.turns.some((turn) => !known.has(turn.speakerId))) { throw new Error("invalid frozen diagnostic evidence"); }
      const turns = transcript.turns.filter((turn) => humans.has(turn.speakerId))
        .map((turn) => Object.freeze(turn.toSnapshot()))
        .toSorted((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || (left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0));
      if (turns.length === 0) { throw new Error("invalid frozen diagnostic evidence"); }
      const binding = validateHistoricalReleaseBinding({
        acceptedMeetingRevision: row.revision, desiredGeneration: 1,
        evidencePolicyVersion: HISTORICAL_EVIDENCE_POLICY_VERSION,
        meetingId: this.#binding.meetingId, releaseId: this.#binding.releaseId,
        roomId: this.#binding.roomId, scopeId: this.#binding.scopeId,
        schemaVersion: 1, transcriptId: transcript.transcriptId, transcriptVersion: transcript.version,
      });
      return Object.freeze({ authoritativeDurationMs: null, binding, humanTurns: Object.freeze(turns), schemaVersion: 1 });
    } catch {
      // Deliberately omit source contents and parser errors from diagnostics.
      throw new Error("frozen diagnostic final evidence is missing, invalid, or changed");
    }
  }

  public async loadAcceptedFinalMeeting(binding: HistoricalReleaseBindingV1, options: HistoricalOperationOptionsV1 = {}): Promise<AcceptedFinalMeetingV1 | null> {
    options.signal?.throwIfAborted();
    const projection = await this.loadFrozenProjection();
    options.signal?.throwIfAborted();
    if (canonicalHistoricalPlannerJson(validateHistoricalReleaseBinding(binding)) !== canonicalHistoricalPlannerJson(projection.binding)) { return null; }
    return projection;
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
