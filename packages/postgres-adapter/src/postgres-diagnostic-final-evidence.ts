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

/** Nonqualifying legacy projection. Never admits or manufactures lifecycle authority. */
export class PostgresDiagnosticFinalEvidence {
  readonly #binding: DiagnosticFinalEvidenceBinding;
  readonly #pool: Pool;
  public constructor(pool: Pool, binding: DiagnosticFinalEvidenceBinding) {
    for (const value of [binding.meetingId, binding.scopeId, binding.roomId, binding.releaseId]) {
      if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) { throw new Error("invalid diagnostic identity"); }
    }
    for (const value of [binding.scopeId, binding.roomId]) {
      if (!value.startsWith("diagnostic:")) { throw new Error("diagnostic namespace required"); }
    }
    if (![binding.snapshotSha256, binding.transcriptSha256].every((value) => /^[a-f0-9]{64}$/u.test(value)) ||
      !Number.isSafeInteger(binding.transcriptVersion) || binding.transcriptVersion < 1) { throw new Error("invalid frozen diagnostic binding"); }
    const actors = [...binding.roster.humans, ...binding.roster.automation];
    if (binding.roster.humans.length === 0 || actors.length > 1_000 || new Set(actors).size !== actors.length ||
      actors.some((value) => typeof value !== "string" || value.trim().length === 0 || value.length > 512)) { throw new Error("invalid diagnostic roster"); }
    this.#pool = pool;
    this.#binding = Object.freeze({ ...binding, roster: Object.freeze({ humans: Object.freeze([...binding.roster.humans]), automation: Object.freeze([...binding.roster.automation]) }) });
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
