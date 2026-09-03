import { constants } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";

import { RecordingIngressError } from "./errors.js";
import type { DecodedPacket } from "./recording-ingress-invariants.js";
import type { RecordingIngressRuntime } from "./recording-ingress-runtime.js";
import { spoolToken } from "./spool.js";

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

interface PendingRecord extends DurableLiveVoicePacket {
  readonly schemaVersion: 1;
  readonly type: "pending";
}

interface DeliveredRecord {
  readonly packetId: string;
  readonly schemaVersion: 1;
  readonly type: "delivered";
}

type OutboxRecord = PendingRecord | DeliveredRecord;

function durableLivePacketIdentity(packet: {
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

export async function pendingLivePackets(
  runtime: RecordingIngressRuntime,
  recordingId: string,
): Promise<readonly DurableLiveVoicePacket[]> {
  return runtime.withExclusiveSpoolOwnership(
    () => runtime.exclusive(recordingId, async () => {
      const records = await readRecords(runtime, recordingId);
      const pending = new Map<string, DurableLiveVoicePacket>();
      const delivered = new Set<string>();
      for (const record of records) {
        if (record.type === "delivered") {
          delivered.add(record.packetId);
          continue;
        }
        const existing = pending.get(record.packetId);
        if (existing !== undefined && !samePacket(existing, record)) {
          throw new RecordingIngressError(
            "conflicting-duplicate",
            "live outbox packet identity was replayed with different content",
          );
        }
        pending.set(record.packetId, record);
      }
      return [...pending.values()]
        .filter(({ packetId }) => !delivered.has(packetId))
        .toSorted(comparePackets);
    }),
  );
}

export async function markLivePacketDelivered(
  runtime: RecordingIngressRuntime,
  packetId: string,
): Promise<"marked" | "reused"> {
  const recordingId = packetId.split(":", 1)[0];
  if (recordingId === undefined || recordingId.length === 0) {
    throw new RecordingIngressError("invalid-input", "live packet identity is invalid");
  }
  return runtime.withExclusiveSpoolOwnership(
    () => runtime.exclusive(recordingId, async () => {
      const records = await readRecords(runtime, recordingId);
      if (records.some((record) => record.type === "delivered" && record.packetId === packetId)) {
        return "reused";
      }
      if (!records.some((record) => record.type === "pending" && record.packetId === packetId)) {
        throw new RecordingIngressError("invalid-input", "live packet identity is unknown");
      }
      await appendRecords(runtime, recordingId, [{
        packetId,
        schemaVersion: 1,
        type: "delivered",
      }]);
      const remaining = await pendingLivePacketsUnlocked(runtime, recordingId);
      if (remaining.length === 0) {
        await rm(outboxPath(runtime, recordingId), { force: true });
      }
      return "marked";
    }),
  );
}

async function pendingLivePacketsUnlocked(
  runtime: RecordingIngressRuntime,
  recordingId: string,
): Promise<readonly DurableLiveVoicePacket[]> {
  const records = await readRecords(runtime, recordingId);
  const delivered = new Set(
    records.filter((record) => record.type === "delivered").map(({ packetId }) => packetId),
  );
  const pending = new Map<string, DurableLiveVoicePacket>();
  for (const record of records) {
    if (record.type === "pending") {
      pending.set(record.packetId, record);
    }
  }
  return [...pending.values()].filter(({ packetId }) => !delivered.has(packetId));
}

async function appendRecords(
  runtime: RecordingIngressRuntime,
  recordingId: string,
  records: readonly OutboxRecord[],
): Promise<void> {
  const root = join(runtime.spool.root, "live-delivery-v1");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new RecordingIngressError("path-policy", "live outbox root is unsafe");
  }
  const path = outboxPath(runtime, recordingId);
  const bytes = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await appendFile(path, bytes, {
    encoding: "utf8",
    flag: constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode: 0o600,
  });
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readRecords(
  runtime: RecordingIngressRuntime,
  recordingId: string,
): Promise<readonly OutboxRecord[]> {
  const path = outboxPath(runtime, recordingId);
  let text: string;
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new RecordingIngressError("path-policy", "live outbox path is unsafe");
    }
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const finalNewline = text.lastIndexOf("\n");
  if (finalNewline !== text.length - 1) {
    await truncate(path, Math.max(0, finalNewline + 1));
    text = finalNewline < 0 ? "" : text.slice(0, finalNewline + 1);
  }
  return text.split("\n").filter(Boolean).map(parseRecord);
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
