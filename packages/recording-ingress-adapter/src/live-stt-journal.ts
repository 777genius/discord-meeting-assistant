import { randomUUID } from "node:crypto";
import { RecordingIngressError } from "./errors.js";
import type { LiveDeliveryIndex, LiveGeneration } from "./live-delivery-index.js";
import { isSttFence } from "./live-stt-journal-contracts.js";
import type {
  SttCompletion, SttDenied, SttFenceReason, SttGrant, SttJournalPort, SttOperation,
  SttOwner, SttRecord, SttRecordingState, SttRecovery, SttSession, SttSpeakerState,
} from "./live-stt-journal-contracts.js";

export interface SttJournalAccess {
  readonly db: LiveDeliveryIndex;
  readonly index: LiveGeneration;
  append(record: SttRecord): Promise<void>;
}
export type SttTransaction = <T>(recordingId: string, work: (access: SttJournalAccess) => Promise<T>) => Promise<T>;
const speakerKey = (speakerId: string): `speaker:${string}` => `speaker:${JSON.stringify(speakerId)}`;
const operationKey = (operation: number): `operation:${number}` => `operation:${operation}`;
function conflict(message: string): never {
  throw new RecordingIngressError("conflicting-duplicate", "live STT " + message);
}
function recording(access: SttJournalAccess): SttRecordingState {
  return access.db.sttGet(access.index, "recording") ?? { initialized: false, epoch: 0, operation: 0 };
}
function speaker(access: SttJournalAccess, id: string): SttSpeakerState {
  return access.db.sttGet(access.index, speakerKey(id)) ?? { generation: 0, opened: false };
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function assertOwner(access: SttJournalAccess, owner: SttOwner): SttRecordingState {
  const state = recording(access);
  if (owner.recordingId !== access.index.recording || owner.epoch !== state.epoch || state.epoch < 1) {
    conflict("stale or conflicting owner");
  }
  return state;
}
function assertSession(access: SttJournalAccess, session: SttSession): SttSpeakerState {
  assertOwner(access, session.owner);
  const state = speaker(access, session.speakerId);
  if (state.generation !== session.generation || session.generation < 1) { conflict("session generation mismatch"); }
  return state;
}
function denied(state: SttRecordingState, current: SttSpeakerState): SttDenied | undefined {
  if (state.endedAtMs !== undefined) { return { status: "recording-closed" }; }
  const reason = current.fence ?? (state.initialized ? undefined : "legacy-unknown");
  return reason === undefined ? undefined : { status: "fenced", reason };
}

/** No process-local payload/receipt history: the existing disposable index owns it. */
export class LiveSttJournal implements SttJournalPort {
  // One durable spool-lifetime identity, independent of recording/cache cardinality.
  readonly #lifetime = randomUUID();
  public constructor(private readonly transaction: SttTransaction) {}

  public recoverRecording(recordingId: string): Promise<SttRecovery> {
    return this.transaction(recordingId, async (access) => {
      let state = recording(access);
      if (state.lifetime !== this.#lifetime) {
        let after = "";
        for (;;) {
          const rows = access.db.sttSpeakers(access.index, after);
          if (rows.length === 0) { break; }
          for (const row of rows) {
            const current = JSON.parse(row.value) as SttSpeakerState;
            if (current.fence === undefined && (current.pending !== undefined || current.opened)) {
              await access.append({ schemaVersion: 2, type: "stt-fence", recordingId,
                speakerId: JSON.parse(row.key.slice(8)) as string, reason: "acceptance-unknown" });
            }
            after = row.key;
          }
        }
        await access.append({ schemaVersion: 2, type: "stt-epoch", recordingId, epoch: state.epoch + 1, lifetime: this.#lifetime });
        state = recording(access);
      }
      const fences: { speakerId: string; reason: SttFenceReason }[] = [];
      let after = "";
      for (;;) {
        const rows = access.db.sttSpeakers(access.index, after);
        if (rows.length === 0) { break; }
        for (const row of rows) {
          const current = JSON.parse(row.value) as SttSpeakerState;
          if (current.fence !== undefined) {
            fences.push({ speakerId: JSON.parse(row.key.slice(8)) as string, reason: current.fence });
          }
          after = row.key;
        }
      }
      return { owner: { recordingId, epoch: state.epoch }, closed: state.endedAtMs !== undefined,
        ...(state.endedAtMs === undefined ? {} : { endedAtMs: state.endedAtMs }), legacy: !state.initialized, fences };
    });
  }

  public beginOpen(owner: SttOwner, speakerId: string): Promise<SttGrant | SttDenied> {
    return this.transaction(owner.recordingId, async (access) => {
      const state = this.assertCurrent(access, owner);
      if (typeof speakerId !== "string" || speakerId.length === 0) { conflict("invalid speaker"); }
      const current = speaker(access, speakerId);
      const rejection = denied(state, current);
      if (rejection !== undefined) { return rejection; }
      if (current.opened || current.pending !== undefined) { conflict("duplicate open"); }
      return this.grant(access, { session: { owner, speakerId, generation: current.generation + 1 },
        operation: state.operation + 1, kind: "open" });
    });
  }

  public beginSend(session: SttSession, packetId: string): Promise<SttGrant | SttDenied | { status: "already-accepted" }> {
    return this.transaction(session.owner.recordingId, async (access) => {
      const state = this.assertCurrent(access, session.owner);
      const current = assertSession(access, session);
      const rejection = denied(state, current);
      if (rejection !== undefined) { return rejection; }
      const row = access.db.get(access.index, packetId);
      if (row === undefined || row.length === 0 || !packetId.startsWith(`${session.owner.recordingId}:${session.speakerId}:`)) {
        conflict("send packet identity is unknown");
      }
      if (row.delivered === 1) { return { status: "already-accepted" }; }
      if (!current.opened || current.pending !== undefined) { conflict("send has no idle opened session"); }
      return this.grant(access, { session, operation: state.operation + 1, kind: "send", packetId });
    });
  }

  public beginFinalize(session: SttSession): Promise<SttGrant | SttDenied> {
    return this.transaction(session.owner.recordingId, async (access) => {
      const state = this.assertCurrent(access, session.owner);
      const current = assertSession(access, session);
      const rejection = denied(state, current);
      if (rejection !== undefined) { return rejection; }
      if (!current.opened || current.pending !== undefined) { conflict("finalize has no idle opened session"); }
      return this.grant(access, { session, operation: state.operation + 1, kind: "finalize" });
    });
  }

  public complete(completion: SttCompletion): Promise<void> {
    const owner = completion.operation.session.owner;
    return this.transaction(owner.recordingId, async (access) => {
      this.assertCurrent(access, owner);
      validateCompletion(access, completion);
      const prior = access.db.sttGet(access.index, operationKey(completion.operation.operation));
      if (prior !== undefined) { return; }
      await access.append({ schemaVersion: 2, type: "stt-outcome", recordingId: owner.recordingId, completion });
    });
  }

  public fence(session: SttSession, reason: SttFenceReason): Promise<void> {
    return this.transaction(session.owner.recordingId, async (access) => {
      this.assertCurrent(access, session.owner);
      const current = assertSession(access, session);
      if (current.fence !== undefined) { return; }
      await access.append({ schemaVersion: 2, type: "stt-fence", recordingId: session.owner.recordingId,
        speakerId: session.speakerId, reason });
    });
  }

  public closeRecording(owner: SttOwner, endedAtMs: number): Promise<void> {
    return this.transaction(owner.recordingId, async (access) => {
      const state = this.assertCurrent(access, owner);
      if (!Number.isSafeInteger(endedAtMs)) { conflict("invalid endedAtMs"); }
      if (state.endedAtMs !== undefined) {
        if (state.endedAtMs !== endedAtMs) { conflict("recording close identity changed"); }
        return;
      }
      await access.append({ schemaVersion: 2, type: "stt-close", recordingId: owner.recordingId, endedAtMs });
    });
  }

  private assertCurrent(access: SttJournalAccess, owner: SttOwner): SttRecordingState {
    if (recording(access).lifetime !== this.#lifetime) { conflict("owner not recovered in this spool lifetime"); }
    if (access.index.conflicting !== 0) { conflict("payload identity conflict"); }
    return assertOwner(access, owner);
  }
  private async grant(access: SttJournalAccess, operation: SttOperation): Promise<SttGrant> {
    await access.append({ schemaVersion: 2, type: "stt-intent", recordingId: operation.session.owner.recordingId, operation });
    return { status: "granted", operation };
  }
}

function validateCompletion(access: SttJournalAccess, completion: SttCompletion): void {
  const { operation, outcome } = completion;
  assertOwner(access, operation.session.owner);
  const previous = access.db.sttGet<SttCompletion>(access.index, operationKey(operation.operation));
  if (previous !== undefined) {
    if (!same(previous, completion)) { conflict("conflicting completion"); }
    return;
  }
  const current = assertSession(access, operation.session);
  if (!same(current.pending, operation)) { conflict("completion has no matching intent"); }
  const success = { open: "opened", send: "accepted", finalize: "finalized" }[operation.kind];
  if (outcome !== success && outcome !== "not-accepted" && !isSttFence(outcome)) { conflict("illegal operation outcome"); }
}

function validateEpoch(state: SttRecordingState, record: Extract<SttRecord, { type: "stt-epoch" }>): void {
  if (record.epoch !== state.epoch + 1 || !Number.isSafeInteger(record.epoch)) { conflict("invalid epoch"); }
  if (record.lifetime !== undefined && (typeof record.lifetime !== "string" || record.lifetime.length === 0)) {
    conflict("invalid spool lifetime");
  }
}

/** The same transition validation runs during streaming replay and after append sync. */
export function applySttRecord(access: SttJournalAccess, record: SttRecord): void {
  if (record.recordingId !== access.index.recording) { conflict("recording identity mismatch"); }
  const state = recording(access);
  switch (record.type) {
    case "stt-init":
      if (state.initialized || state.epoch !== 0) { conflict("format initialized twice or after recovery"); }
      state.initialized = true;
      break;
    case "stt-epoch":
      validateEpoch(state, record);
      state.lifetime = record.lifetime;
      state.epoch = record.epoch;
      break;
    case "stt-close":
      if (!Number.isSafeInteger(record.endedAtMs) || (state.endedAtMs !== undefined && state.endedAtMs !== record.endedAtMs)) {
        conflict("invalid recording close");
      }
      state.endedAtMs = record.endedAtMs;
      break;
    case "stt-fence": {
      if (typeof record.speakerId !== "string" || !isSttFence(record.reason)) { conflict("invalid fence"); }
      const current = speaker(access, record.speakerId);
      current.fence ??= record.reason;
      access.db.sttPut(access.index, speakerKey(record.speakerId), current);
      break;
    }
    case "stt-intent": applyIntent(access, state, record.operation); break;
    case "stt-outcome": applyOutcome(access, record.completion); break;
  }
  access.db.sttPut(access.index, "recording", state);
}

function applyIntent(access: SttJournalAccess, state: SttRecordingState, operation: SttOperation): void {
  assertOwner(access, operation.session.owner);
  const { session } = operation;
  if (typeof session.speakerId !== "string" || session.speakerId.length === 0 ||
      !Number.isSafeInteger(session.generation) || !Number.isSafeInteger(operation.operation) ||
      operation.operation !== state.operation + 1) { conflict("invalid intent identity"); }
  const current = speaker(access, session.speakerId);
  if (denied(state, current) !== undefined || current.pending !== undefined) { conflict("intent on unavailable session"); }
  if (operation.kind === "open") {
    if (current.opened || session.generation !== current.generation + 1) { conflict("invalid opening generation"); }
    current.generation = session.generation;
    current.accepted = false;
  } else {
    if (!isSessionIntentKind(operation.kind) ||
        !current.opened || session.generation !== current.generation) { conflict("invalid session intent"); }
    if (operation.kind === "send") {
      const row = access.db.get(access.index, operation.packetId);
      if (row === undefined || row.length === 0 || row.delivered !== 0 ||
          !operation.packetId.startsWith(`${session.owner.recordingId}:${session.speakerId}:`)) { conflict("invalid send identity"); }
    }
  }
  current.pending = operation;
  state.operation = operation.operation;
  access.db.sttPut(access.index, speakerKey(session.speakerId), current);
}

function applyOutcome(access: SttJournalAccess, completion: SttCompletion): void {
  validateCompletion(access, completion);
  const { operation, outcome } = completion;
  const current = speaker(access, operation.session.speakerId);
  if (access.db.sttGet(access.index, operationKey(operation.operation)) !== undefined) { return; }
  if (outcome === "opened") { current.opened = true; }
  if (outcome === "accepted") { current.accepted = true; current.failedAttempts = 0; }
  if (outcome === "not-accepted") {
    current.failedAttempts = (current.failedAttempts ?? 0) + 1;
    if (current.failedAttempts >= 2) { current.fence ??= "admission-rejected"; }
  }
  if (outcome === "not-accepted" && current.accepted === true) { current.fence ??= "acceptance-unknown"; }
  if (outcome === "finalized" || outcome === "not-accepted") { current.opened = false; }
  if (isSttFence(outcome)) { current.fence ??= outcome; }
  delete current.pending;
  access.db.sttPut(access.index, speakerKey(operation.session.speakerId), current);
  access.db.sttPut(access.index, operationKey(operation.operation), completion);
}

function isSessionIntentKind(kind: unknown): boolean {
  return kind === "send" || kind === "finalize";
}
