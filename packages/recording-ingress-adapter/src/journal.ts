import { constants } from "node:fs";
import { lstat, open, truncate } from "node:fs/promises";

import { oggCrc32 } from "./crc32.js";
import { RecordingIngressError } from "./errors.js";
import type { JournalPacket } from "./ogg-opus.js";

const RECORD_PREFIX_BYTES = 4;
const RECORD_FIXED_BODY_BYTES = 26;
const RECORD_CRC_BYTES = 4;
const MIN_RECORD_BYTES = RECORD_FIXED_BODY_BYTES + RECORD_CRC_BYTES;

export interface JournalScan {
  readonly opusBytes: number;
  readonly packets: readonly JournalPacket[];
}

function encodePacket(packet: JournalPacket): Uint8Array {
  const bodyLength = RECORD_FIXED_BODY_BYTES + packet.opus.byteLength;
  const recordLength = bodyLength + RECORD_CRC_BYTES;
  const encoded = new Uint8Array(RECORD_PREFIX_BYTES + recordLength);
  const view = new DataView(encoded.buffer);
  view.setUint32(0, recordLength, true);
  view.setUint32(4, packet.rtpTimestamp, true);
  view.setUint16(8, packet.rtpSequence, true);
  view.setBigUint64(10, BigInt(packet.relativeTimeMs), true);
  view.setBigUint64(18, BigInt(packet.receivedAtMs), true);
  view.setUint32(26, packet.opus.byteLength, true);
  encoded.set(packet.opus, 30);
  view.setUint32(30 + packet.opus.byteLength, oggCrc32(encoded.subarray(4, 30 + packet.opus.byteLength)), true);
  return encoded;
}

function decodePacket(record: Uint8Array, maxOpusBytesPerPacket: number): JournalPacket {
  if (record.byteLength < MIN_RECORD_BYTES) {
    throw new RecordingIngressError("corrupt-spool", "journal record is too short");
  }
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const opusLength = view.getUint32(22, true);
  if (
    opusLength === 0 ||
    opusLength > maxOpusBytesPerPacket ||
    record.byteLength !== RECORD_FIXED_BODY_BYTES + opusLength + RECORD_CRC_BYTES
  ) {
    throw new RecordingIngressError("corrupt-spool", "journal record has an invalid Opus size");
  }
  const storedCrc = view.getUint32(RECORD_FIXED_BODY_BYTES + opusLength, true);
  const payload = record.subarray(0, RECORD_FIXED_BODY_BYTES + opusLength);
  if (oggCrc32(payload) !== storedCrc) {
    throw new RecordingIngressError("corrupt-spool", "journal record CRC mismatch");
  }

  const relativeTime = view.getBigUint64(6, true);
  const receivedAt = view.getBigUint64(14, true);
  if (relativeTime > BigInt(Number.MAX_SAFE_INTEGER) || receivedAt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RecordingIngressError("corrupt-spool", "journal timestamp is out of range");
  }
  return {
    opus: record.slice(RECORD_FIXED_BODY_BYTES, RECORD_FIXED_BODY_BYTES + opusLength),
    receivedAtMs: Number(receivedAt),
    relativeTimeMs: Number(relativeTime),
    rtpSequence: view.getUint16(4, true),
    rtpTimestamp: view.getUint32(0, true),
  };
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(bytes, read, length - read, position + read);
    if (result.bytesRead === 0) {
      break;
    }
    read += result.bytesRead;
  }
  return read === length ? bytes : bytes.subarray(0, read);
}

async function assertRegularFile(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new RecordingIngressError("path-policy", "journal path is not a regular file");
  }
}

export async function scanJournal(
  path: string,
  options: {
    readonly maxOpusBytesPerPacket: number;
    readonly maxPackets: number;
    readonly repairIncompleteTail: boolean;
  },
): Promise<JournalScan> {
  try {
    await assertRegularFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { opusBytes: 0, packets: [] };
    }
    throw error;
  }

  const handle = await open(path, "r");
  const packets: JournalPacket[] = [];
  let opusBytes = 0;
  let offset = 0;
  let incompleteTail = false;
  try {
    const stats = await handle.stat();
    while (offset < stats.size) {
      const prefix = await readExactly(handle, RECORD_PREFIX_BYTES, offset);
      if (prefix.byteLength < RECORD_PREFIX_BYTES) {
        incompleteTail = true;
        break;
      }
      const recordLength = new DataView(
        prefix.buffer,
        prefix.byteOffset,
        prefix.byteLength,
      ).getUint32(0, true);
      if (
        recordLength < MIN_RECORD_BYTES ||
        recordLength > RECORD_FIXED_BODY_BYTES + options.maxOpusBytesPerPacket + RECORD_CRC_BYTES
      ) {
        throw new RecordingIngressError("corrupt-spool", "journal record length is invalid");
      }
      const record = await readExactly(handle, recordLength, offset + RECORD_PREFIX_BYTES);
      if (record.byteLength < recordLength) {
        incompleteTail = true;
        break;
      }
      const packet = decodePacket(record, options.maxOpusBytesPerPacket);
      packets.push(packet);
      opusBytes += packet.opus.byteLength;
      if (packets.length > options.maxPackets) {
        throw new RecordingIngressError(
          "limit-exceeded",
          "journal exceeds the configured packet limit",
        );
      }
      offset += RECORD_PREFIX_BYTES + recordLength;
    }
  } finally {
    await handle.close();
  }

  if (incompleteTail) {
    if (!options.repairIncompleteTail) {
      throw new RecordingIngressError("corrupt-spool", "journal has an incomplete tail");
    }
    await truncate(path, offset);
    const repairHandle = await open(path, "r+");
    try {
      await repairHandle.sync();
    } finally {
      await repairHandle.close();
    }
  }
  return { opusBytes, packets };
}

export async function appendJournal(
  path: string,
  packets: readonly JournalPacket[],
): Promise<void> {
  if (packets.length === 0) {
    return;
  }
  const records = packets.map(encodePacket);
  const totalLength = records.reduce((total, record) => total + record.byteLength, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const record of records) {
    bytes.set(record, offset);
    offset += record.byteLength;
  }

  const flags =
    constants.O_APPEND |
    constants.O_CREAT |
    constants.O_WRONLY |
    constants.O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function journalPacketIdentity(packet: JournalPacket): string {
  return `${packet.rtpTimestamp}:${packet.rtpSequence}:${packet.relativeTimeMs}`;
}

export function journalPacketsEqual(left: JournalPacket, right: JournalPacket): boolean {
  return (
    left.rtpTimestamp === right.rtpTimestamp &&
    left.rtpSequence === right.rtpSequence &&
    left.relativeTimeMs === right.relativeTimeMs &&
    left.receivedAtMs === right.receivedAtMs &&
    Buffer.compare(left.opus, right.opus) === 0
  );
}
