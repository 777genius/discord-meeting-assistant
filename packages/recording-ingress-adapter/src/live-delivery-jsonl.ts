import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import { RecordingIngressError } from "./errors.js";

export interface DurableLiveVoicePacket {
  readonly mediaTimestamp: number;
  readonly packetId: string;
  readonly payloadBase64: string;
  readonly receivedAtMs: number;
  readonly recordingId: string;
  readonly relativeTimeMs: number;
  readonly sequenceNumber: number;
  readonly speakerId: string;
}

export interface PendingRecord extends DurableLiveVoicePacket {
  readonly schemaVersion: 1;
  readonly type: "pending";
}

interface DeliveredRecord {
  readonly packetId: string;
  readonly schemaVersion: 1;
  readonly type: "delivered";
}

export type OutboxRecord = PendingRecord | DeliveredRecord;

export function durableLivePacketIdentity(packet: {
  readonly mediaTimestamp: number;
  readonly recordingId: string;
  readonly relativeTimeMs: number;
  readonly sequenceNumber: number;
  readonly speakerId: string;
}): string {
  return [
    packet.recordingId,
    packet.speakerId,
    packet.mediaTimestamp,
    packet.sequenceNumber,
    packet.relativeTimeMs,
  ].join(":");
}

function parseRecord(line: string): OutboxRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new RecordingIngressError("corrupt-spool", "live outbox record is invalid JSON", {
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null) {
    throw new RecordingIngressError("corrupt-spool", "live outbox record is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.packetId !== "string" ||
    record.packetId.length === 0 ||
    record.packetId.length > 4_096
  ) {
    throw new RecordingIngressError("corrupt-spool", "live outbox identity is invalid");
  }
  if (record.type === "delivered") {
    return { packetId: record.packetId, schemaVersion: 1, type: "delivered" };
  }
  if (
    record.type !== "pending" ||
    typeof record.payloadBase64 !== "string" ||
    typeof record.recordingId !== "string" ||
    typeof record.speakerId !== "string" ||
    !Number.isSafeInteger(record.mediaTimestamp) ||
    !Number.isSafeInteger(record.receivedAtMs) ||
    !Number.isSafeInteger(record.relativeTimeMs) ||
    !Number.isSafeInteger(record.sequenceNumber)
  ) {
    throw new RecordingIngressError("corrupt-spool", "live outbox packet is invalid");
  }
  const packet = {
    mediaTimestamp: record.mediaTimestamp as number,
    packetId: record.packetId,
    payloadBase64: record.payloadBase64,
    receivedAtMs: record.receivedAtMs as number,
    recordingId: record.recordingId,
    relativeTimeMs: record.relativeTimeMs as number,
    sequenceNumber: record.sequenceNumber as number,
    speakerId: record.speakerId,
  };
  if (durableLivePacketIdentity(packet) !== packet.packetId) {
    throw new RecordingIngressError("corrupt-spool", "live outbox packet identity does not match");
  }
  return { ...packet, schemaVersion: 1, type: "pending" };
}


export async function fileStamp(path: string): Promise<string> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new RecordingIngressError("path-policy", "live outbox path is unsafe");
    }
    return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { return "missing"; }
    throw error;
  }
}

async function descriptorStamp(handle: FileHandle): Promise<string> {
  const stats = await handle.stat({ bigint: true });
  if (!stats.isFile()) {
    throw new RecordingIngressError("path-policy", "live outbox descriptor is unsafe");
  }
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}

export async function verifiedStamp(handle: FileHandle, path: string): Promise<string> {
  const stamp = await descriptorStamp(handle);
  if (stamp !== await fileStamp(path)) {
    throw new RecordingIngressError("corrupt-spool", "live outbox changed during operation");
  }
  return stamp;
}

export async function readOffset(
  handle: FileHandle, offset: number, length: number,
): Promise<OutboxRecord> {
  const buffer = Buffer.alloc(length);
  let position = 0;
  while (position < length) {
    const { bytesRead } = await handle.read(buffer, position, length - position, offset + position);
    if (bytesRead === 0) {
      throw new RecordingIngressError("corrupt-spool", "live outbox offset is truncated");
    }
    position += bytesRead;
  }
  return parseRecord(buffer.toString("utf8"));
}

export async function openEvidence(path: string): Promise<FileHandle> {
  return open(path, constants.O_RDWR | constants.O_NOFOLLOW);
}

/** Keeps only one read chunk and the current row, never a historical payload map. */
export async function scanEvidence(
  handle: FileHandle,
  initialStamp: string,
  consume: (record: OutboxRecord, offset: number, length: number) => Promise<void>,
): Promise<void> {
  const chunk = Buffer.alloc(64 * 1024);
  let tail = Buffer.alloc(0);
  let position = 0;
  let rowOffset = 0;
  let rows = 0;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) { break; }
    position += bytesRead;
    const bytes = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
    let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      if (end > start) {
        await consume(parseRecord(bytes.subarray(start, end).toString("utf8")), rowOffset, end - start);
      }
      rowOffset += end - start + 1;
      start = end + 1;
      rows += 1;
      if (rows % 256 === 0) {
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
    }
    tail = Buffer.from(bytes.subarray(start));
  }
  if (await descriptorStamp(handle) !== initialStamp) {
    throw new RecordingIngressError("corrupt-spool", "live outbox changed during recovery");
  }
  if (tail.length > 0) { await handle.truncate(rowOffset); }
}

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
