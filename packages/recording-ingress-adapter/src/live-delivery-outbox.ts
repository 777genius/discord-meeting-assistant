import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { RecordingIngressError } from "./errors.js";
import type { LiveDeliveryIndex, LiveGeneration } from "./live-delivery-index.js";
import {
  durableLivePacketIdentity, fileStamp, openEvidence, readOffset,
  scanEvidence, syncDirectory, verifiedStamp,
  type DurableLiveVoicePacket, type OutboxRecord, type PendingRecord,
} from "./live-delivery-jsonl.js";
import type { DecodedPacket } from "./recording-ingress-invariants.js";
import type { RecordingIngressRuntime } from "./recording-ingress-runtime.js";
import { applySttRecord, LiveSttJournal } from "./live-stt-journal.js";
import type { SttRecordingState } from "./live-stt-journal-contracts.js";
import { spoolToken } from "./spool.js";

export type { DurableLiveVoicePacket } from "./live-delivery-jsonl.js";
const RECOVERY_LOCK = Symbol("live-delivery-recovery");

async function applyRecord(
  db: LiveDeliveryIndex, index: LiveGeneration, handle: FileHandle,
  record: OutboxRecord, location: { offset: number; length: number },
): Promise<void> {
  if (record.schemaVersion === 2) {
    applySttRecord({ db, index, append: () => { throw new Error("replay cannot append"); } }, record);
    if (record.type === "stt-outcome" && record.completion.outcome === "accepted") {
      await applyRecord(db, index, handle, { schemaVersion: 1, type: "delivered",
        packetId: record.completion.operation.packetId }, location);
    }
    return;
  }
  const previous = db.get(index, record.packetId);
  if (record.type === "delivered") {
    if (previous !== undefined && previous.length > 0 && previous.delivered === 0) {
      index.remaining -= 1;
    }
    db.put(index, { packet: record.packetId, offset: previous?.offset ?? 0,
      length: previous?.length ?? 0, delivered: 1 });
  } else {
    if (previous !== undefined && previous.length > 0) {
      const prior = await readOffset(handle, previous.offset, previous.length);
      if (prior.type !== "pending" || !samePacket(prior, record)) { index.conflicting = 1; }
    } else if (previous?.delivered !== 1) { index.remaining += 1; }
    db.put(index, { packet: record.packetId, ...location, delivered: previous?.delivered ?? 0 });
    db.packetOrder(index, record.packetId, record.speakerId, record.relativeTimeMs, record.mediaTimestamp, record.sequenceNumber);
  }
}

async function readIndex(runtime: RecordingIngressRuntime, recordingId: string): Promise<LiveGeneration> {
  const db = await runtime.liveDeliveryIndex();
  const path = outboxPath(runtime, recordingId);
  try {
    const root = await lstat(join(runtime.spool.root, "live-delivery-v1"));
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new RecordingIngressError("path-policy", "live outbox root is unsafe");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
  }
  const stamp = await fileStamp(path);
  const cached = db.find(recordingId);
  if (cached?.stamp === stamp) { return cached; }
  return runtime.exclusive(RECOVERY_LOCK, async () => {
    if (cached !== undefined) { await db.forget(cached); }
    const index = db.begin(recordingId);
    const initial = await fileStamp(path);
    if (initial === "missing") {
      index.stamp = initial;
      db.publish(index);
      return index;
    }
    const handle = await openEvidence(path);
    let finalStamp: string;
    try {
      if (await verifiedStamp(handle, path) !== initial) {
        throw new RecordingIngressError("corrupt-spool", "live outbox changed before recovery");
      }
      await scanEvidence(handle, initial, (record, offset, length) =>
        applyRecord(db, index, handle, record, { offset, length }));
      // Includes surviving complete receipts from an earlier uncertain append.
      await handle.sync();
      await syncDirectory(join(runtime.spool.root, "live-delivery-v1"));
      await syncDirectory(runtime.spool.root);
      finalStamp = await verifiedStamp(handle, path);
    } finally { await handle.close(); }
    if (await fileStamp(path) !== finalStamp) {
      throw new RecordingIngressError("corrupt-spool", "live outbox changed on recovery close");
    }
    index.stamp = finalStamp;
    db.publish(index);
    return index;
  });
}

export async function appendPendingLivePackets(
  runtime: RecordingIngressRuntime,
  packets: readonly DecodedPacket[],
): Promise<void> {
  if (packets.length === 0) {
    return;
  }
  const recordingId = packets[0]?.recordingId;
  if (recordingId === undefined || packets.some((packet) => packet.recordingId !== recordingId)) {
    throw new RecordingIngressError("invalid-input", "live outbox batch identity is invalid");
  }
  const records = packets.map<PendingRecord>((packet) => {
    const identity = {
      mediaTimestamp: packet.rtpTimestamp,
      recordingId: packet.recordingId,
      relativeTimeMs: packet.relativeTimeMs,
      sequenceNumber: packet.rtpSequence,
      speakerId: packet.speakerId,
    };
    return {
      ...identity,
      packetId: durableLivePacketIdentity(identity),
      payloadBase64: Buffer.from(packet.opus).toString("base64"),
      receivedAtMs: packet.receivedAtMs,
      schemaVersion: 1,
      type: "pending",
    };
  });
  await appendRecords(runtime, recordingId, records);
}

/** A cursor (including "" for the first page) selects bounded eligible recovery.
 * Omitted cursors retain the legacy evidence-inspection API.
 */
export async function pendingLivePackets(
  runtime: RecordingIngressRuntime, recordingId: string, afterPacket?: string,
): Promise<readonly DurableLiveVoicePacket[]> {
  return runtime.withExclusiveSpoolOwnership(() => runtime.exclusive(recordingId, async () => {
    const index = await readIndex(runtime, recordingId);
    if (index.conflicting !== 0) {
      throw new RecordingIngressError("conflicting-duplicate", "live outbox packet identity was replayed with different content");
    }
    if (index.stamp === "missing") { return []; }
    const db = await runtime.liveDeliveryIndex();
    const state = db.sttGet<SttRecordingState>(index, "recording");
    if (afterPacket !== undefined && (state?.initialized !== true || state.endedAtMs !== undefined)) { return []; }
    const path = outboxPath(runtime, recordingId);
    const handle = await openEvidence(path);
    const packets: DurableLiveVoicePacket[] = [];
    try {
      if (await verifiedStamp(handle, path) !== index.stamp) {
        throw new RecordingIngressError("corrupt-spool", "live outbox changed before pending read");
      }
      let after = afterPacket ?? "";
      for (;;) {
        const rows = afterPacket === undefined ? db.pending(index, after) : db.eligible(index, after);
        if (rows.length === 0) { break; }
        for (const row of rows) {
          const record = await readOffset(handle, row.offset, row.length);
          if (record.type !== "pending" || record.packetId !== row.packet) {
            throw new RecordingIngressError("corrupt-spool", "live outbox offset identity is invalid");
          }
          packets.push(record);
          after = row.packet;
        }
        if (afterPacket !== undefined) { break; }
      }
      if (await verifiedStamp(handle, path) !== index.stamp) {
        throw new RecordingIngressError("corrupt-spool", "live outbox changed during pending read");
      }
    } catch (error) { db.invalidate(index); throw error; }
    finally { await handle.close(); }
    return afterPacket === undefined ? packets.toSorted(comparePackets) : packets;
  }));
}

export async function markLivePacketDelivered(
  runtime: RecordingIngressRuntime, packetId: string,
): Promise<"marked" | "reused"> {
  const recordingId = packetId.split(":", 1)[0];
  if (recordingId === undefined || recordingId.length === 0) {
    throw new RecordingIngressError("invalid-input", "live packet identity is invalid");
  }
  return runtime.withExclusiveSpoolOwnership(() => runtime.exclusive(recordingId, async () => {
    const index = await readIndex(runtime, recordingId);
    const db = await runtime.liveDeliveryIndex();
    if (db.sttGet<SttRecordingState>(index, "recording")?.initialized === true) {
      throw new RecordingIngressError("invalid-state", "new-format live delivery requires an accepted operation outcome");
    }
    const row = db.get(index, packetId);
    if (row?.delivered === 1) { return "reused"; }
    if (row === undefined || row.length === 0) {
      throw new RecordingIngressError("invalid-input", "live packet identity is unknown");
    }
    await appendRecords(runtime, recordingId, [{ packetId, schemaVersion: 1, type: "delivered" }], index);
    return "marked";
  }));
}

async function appendRecords(
  runtime: RecordingIngressRuntime, recordingId: string, records: readonly OutboxRecord[],
  known?: LiveGeneration,
): Promise<void> {
  const root = join(runtime.spool.root, "live-delivery-v1");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new RecordingIngressError("path-policy", "live outbox root is unsafe");
  }
  const db = await runtime.liveDeliveryIndex();
  const index = known ?? await readIndex(runtime, recordingId);
  const path = outboxPath(runtime, recordingId);
  db.invalidate(index);
  const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let finalStamp: string;
  try {
    const before = await verifiedStamp(handle, path);
    if (index.stamp !== "missing" && before !== index.stamp) {
      throw new RecordingIngressError("corrupt-spool", "live outbox changed before append");
    }
    const startOffset = (await handle.stat()).size;
    let offset = startOffset;
    if (index.stamp === "missing" && offset !== 0) {
      throw new RecordingIngressError("corrupt-spool", "live outbox appeared before append");
    }
    for (const record of records) {
      const bytes = JSON.stringify(record) + "\n";
      await handle.writeFile(bytes, "utf8");
      offset += Buffer.byteLength(bytes);
    }
    await handle.sync();
    if (index.stamp === "missing") {
      await syncDirectory(root);
      await syncDirectory(runtime.spool.root);
    }
    finalStamp = await verifiedStamp(handle, path);
    if (Number(finalStamp.split(":")[2]) !== offset) {
      throw new RecordingIngressError("corrupt-spool", "live outbox append length changed");
    }
    // Publish metadata only after the authoritative bytes passed durability and
    // descriptor checks. No SQLite transaction spans any of these awaits.
    offset = startOffset;
    for (const record of records) {
      const length = Buffer.byteLength(JSON.stringify(record));
      await applyRecord(db, index, handle, record, { offset, length });
      offset += length + 1;
    }
  } finally { await handle.close(); }
  if (await fileStamp(path) !== finalStamp) {
    throw new RecordingIngressError("corrupt-spool", "live outbox changed on append close");
  }
  index.stamp = finalStamp;
  db.publish(index);
}

function outboxPath(runtime: RecordingIngressRuntime, recordingId: string): string {
  return join(
    runtime.spool.root,
    "live-delivery-v1",
    spoolToken("live-delivery-v1", recordingId) + ".jsonl",
  );
}

function samePacket(left: DurableLiveVoicePacket, right: DurableLiveVoicePacket): boolean {
  return left.payloadBase64 === right.payloadBase64 &&
    left.receivedAtMs === right.receivedAtMs;
}

function comparePackets(left: DurableLiveVoicePacket, right: DurableLiveVoicePacket): number {
  return left.relativeTimeMs - right.relativeTimeMs ||
    left.speakerId.localeCompare(right.speakerId) ||
    left.mediaTimestamp - right.mediaTimestamp ||
    left.sequenceNumber - right.sequenceNumber;
}

/** Called only in the verified new-recording creation critical section. */
export async function initializeLiveStt(runtime: RecordingIngressRuntime, recordingId: string): Promise<void> {
  const index = await readIndex(runtime, recordingId);
  if (index.stamp !== "missing") {
    throw new RecordingIngressError("conflicting-duplicate", "new recording already has live evidence");
  }
  await appendRecords(runtime, recordingId, [{ schemaVersion: 2, type: "stt-init", recordingId }], index);
}

const journals = new WeakMap<RecordingIngressRuntime, LiveSttJournal>();
export function liveSttJournal(runtime: RecordingIngressRuntime): LiveSttJournal {
  let journal = journals.get(runtime);
  if (journal === undefined) {
    journal = new LiveSttJournal((recordingId, work) => runtime.withExclusiveSpoolOwnership(() =>
      runtime.exclusive(recordingId, async () => {
        const index = await readIndex(runtime, recordingId);
        const db = await runtime.liveDeliveryIndex();
        const active = await runtime.spool.readRecording(recordingId);
        const terminal = active === undefined
          ? await runtime.spool.readCompleted(recordingId) ?? await runtime.spool.readAborted(recordingId)
          : active.status === "active" ? undefined : active;
        const endedAt = terminal?.events.find((event) => event.type === "meeting.ended" || event.type === "meeting.aborted")?.occurredAt;
        if (endedAt !== undefined) {
          const persisted = db.sttGet<SttRecordingState>(index, "recording")?.endedAtMs;
          if (persisted !== undefined && persisted !== Date.parse(endedAt)) {
            throw new RecordingIngressError("conflicting-duplicate", "live STT terminal lifecycle identity changed");
          }
          if (persisted === undefined) {
            await appendRecords(runtime, recordingId, [{ schemaVersion: 2, type: "stt-close", recordingId,
              endedAtMs: Date.parse(endedAt) }], index);
          }
        }
        return work({ db, index, append: (record) => appendRecords(runtime, recordingId, [record], index) });
      })));
    journals.set(runtime, journal);
  }
  return journal;
}
