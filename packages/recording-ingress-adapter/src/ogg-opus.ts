import { createHash } from "node:crypto";

import type {
  OggOpusPageSummary,
  OggOpusValidationResult,
} from "./contracts.js";
import { oggCrc32 } from "./crc32.js";
import { RecordingIngressError } from "./errors.js";

const CAPTURE_PATTERN = new TextEncoder().encode("OggS");
const OPUS_HEAD = new TextEncoder().encode("OpusHead");
const OPUS_TAGS = new TextEncoder().encode("OpusTags");
const OPUS_CLOCK_RATE = 48_000;
const MAX_OPUS_PACKET_DURATION_SAMPLES = 5_760;

export interface JournalPacket {
  readonly opus: Uint8Array;
  readonly receivedAtMs: number;
  readonly relativeTimeMs: number;
  readonly rtpSequence: number;
  readonly rtpTimestamp: number;
}

export interface CompiledOggOpus {
  readonly bytes: Uint8Array;
  readonly durationMs: number;
  readonly packetCount: number;
  readonly serial: number;
  readonly timelineOffsetMs: number;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function packetLacing(packetLength: number): Uint8Array {
  const completeSegments = Math.floor(packetLength / 255);
  const remainder = packetLength % 255;
  const segmentCount = completeSegments + 1;
  if (segmentCount > 255) {
    throw new RecordingIngressError(
      "invalid-input",
      "Opus packet is too large for a single bounded Ogg page",
    );
  }

  const lacing = new Uint8Array(segmentCount);
  lacing.fill(255, 0, completeSegments);
  lacing[segmentCount - 1] = remainder;
  return lacing;
}

function createPage(input: {
  readonly body: Uint8Array;
  readonly granulePosition: bigint;
  readonly headerType: number;
  readonly sequence: number;
  readonly serial: number;
}): Uint8Array {
  const lacing = packetLacing(input.body.byteLength);
  const page = new Uint8Array(27 + lacing.byteLength + input.body.byteLength);
  page.set(CAPTURE_PATTERN, 0);
  page[4] = 0;
  page[5] = input.headerType;
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
  view.setBigUint64(6, input.granulePosition, true);
  view.setUint32(14, input.serial, true);
  view.setUint32(18, input.sequence, true);
  view.setUint32(22, 0, true);
  page[26] = lacing.byteLength;
  page.set(lacing, 27);
  page.set(input.body, 27 + lacing.byteLength);
  view.setUint32(22, oggCrc32(page), true);
  return page;
}

function createOpusHead(): Uint8Array {
  const packet = new Uint8Array(19);
  packet.set(OPUS_HEAD, 0);
  packet[8] = 1;
  packet[9] = 1;
  const view = new DataView(packet.buffer);
  view.setUint16(10, 0, true);
  view.setUint32(12, OPUS_CLOCK_RATE, true);
  view.setInt16(16, 0, true);
  packet[18] = 0;
  return packet;
}

function createOpusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("discord-meeting/recording-ingress-v1");
  const packet = new Uint8Array(16 + vendor.byteLength);
  packet.set(OPUS_TAGS, 0);
  const view = new DataView(packet.buffer);
  view.setUint32(8, vendor.byteLength, true);
  packet.set(vendor, 12);
  view.setUint32(12 + vendor.byteLength, 0, true);
  return packet;
}

export function opusPacketDurationSamples(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) {
    throw new RecordingIngressError("invalid-input", "Opus packet is empty");
  }

  const config = toc >>> 3;
  let frameDurationSamples: number;
  if (config >= 16) {
    frameDurationSamples = 120 << (config & 0b11);
  } else if (config >= 12) {
    frameDurationSamples = 480 << (config & 0b1);
  } else if ((config & 0b11) === 0b11) {
    frameDurationSamples = 2_880;
  } else {
    frameDurationSamples = 480 << (config & 0b11);
  }

  const frameCode = toc & 0b11;
  let frameCount: number;
  if (frameCode === 0) {
    frameCount = 1;
  } else if (frameCode === 1 || frameCode === 2) {
    frameCount = 2;
  } else {
    const countByte = packet[1];
    if (countByte === undefined) {
      throw new RecordingIngressError(
        "invalid-input",
        "Opus packet omits its frame count",
      );
    }
    frameCount = countByte & 0x3f;
    if (frameCount === 0) {
      throw new RecordingIngressError(
        "invalid-input",
        "Opus packet declares zero frames",
      );
    }
  }

  const duration = frameDurationSamples * frameCount;
  if (duration > MAX_OPUS_PACKET_DURATION_SAMPLES) {
    throw new RecordingIngressError(
      "invalid-input",
      "Opus packet duration exceeds 120 ms",
    );
  }
  return duration;
}

function comparePackets(left: JournalPacket, right: JournalPacket): number {
  return (
    left.relativeTimeMs - right.relativeTimeMs ||
    left.receivedAtMs - right.receivedAtMs ||
    left.rtpTimestamp - right.rtpTimestamp ||
    left.rtpSequence - right.rtpSequence ||
    Buffer.compare(left.opus, right.opus)
  );
}

function deterministicSerial(recordingId: string, speakerId: string): number {
  const digest = createHash("sha256")
    .update("ogg-opus-v1\0")
    .update(recordingId)
    .update("\0")
    .update(speakerId)
    .digest();
  return digest.readUInt32LE(0);
}

function localPacketStarts(packets: readonly JournalPacket[]): readonly number[] {
  const first = packets[0];
  if (first === undefined) {
    return [];
  }
  const starts: number[] = [0];

  for (let index = 1; index < packets.length; index += 1) {
    const previous = packets[index - 1];
    const packet = packets[index];
    if (previous === undefined || packet === undefined) {
      throw new RecordingIngressError("corrupt-spool", "packet ordering failed");
    }

    const relativeStart = Math.round(
      (packet.relativeTimeMs - first.relativeTimeMs) * 48,
    );
    const previousStart = starts[index - 1];
    if (previousStart === undefined) {
      throw new RecordingIngressError("corrupt-spool", "packet timing failed");
    }
    const timestampForward = (packet.rtpTimestamp - previous.rtpTimestamp) >>> 0;
    const sequenceForward = (packet.rtpSequence - previous.rtpSequence) & 0xffff;
    const rtpStart = previousStart + timestampForward;
    const timingDifference = Math.abs(rtpStart - relativeStart);
    const rtpLooksContinuous =
      timestampForward <= OPUS_CLOCK_RATE * 10 &&
      sequenceForward > 0 &&
      sequenceForward <= 2_000 &&
      timingDifference <= MAX_OPUS_PACKET_DURATION_SAMPLES;

    // RTP is more precise within a connection. relativeTimeMs is authoritative
    // across reconnects, large gaps, clock resets and reordered delivery.
    starts.push(rtpLooksContinuous ? rtpStart : relativeStart);
  }
  return starts;
}

export function compileOggOpus(
  recordingId: string,
  speakerId: string,
  sourcePackets: readonly JournalPacket[],
): CompiledOggOpus {
  if (sourcePackets.length === 0) {
    throw new RecordingIngressError(
      "invalid-input",
      "cannot compile an empty speaker stream",
    );
  }

  const packets = sourcePackets.toSorted(comparePackets);
  const starts = localPacketStarts(packets);
  const serial = deterministicSerial(recordingId, speakerId);
  const pages: Uint8Array[] = [
    createPage({
      body: createOpusHead(),
      granulePosition: 0n,
      headerType: 0x02,
      sequence: 0,
      serial,
    }),
    createPage({
      body: createOpusTags(),
      granulePosition: 0n,
      headerType: 0,
      sequence: 1,
      serial,
    }),
  ];

  let finalGranule = 0;
  for (let index = 0; index < packets.length; index += 1) {
    const packet = packets[index];
    const start = starts[index];
    if (packet === undefined || start === undefined) {
      throw new RecordingIngressError("corrupt-spool", "packet timing failed");
    }
    const end = start + opusPacketDurationSamples(packet.opus);
    finalGranule = Math.max(finalGranule, end);
    pages.push(
      createPage({
        body: packet.opus,
        granulePosition: BigInt(finalGranule),
        headerType: index === packets.length - 1 ? 0x04 : 0,
        sequence: index + 2,
        serial,
      }),
    );
  }

  const bytes = concatenate(pages);
  validateOggOpus(bytes);
  return {
    bytes,
    durationMs: finalGranule / 48,
    packetCount: packets.length,
    serial,
    timelineOffsetMs: packets[0]?.relativeTimeMs ?? 0,
  };
}

function bytesEqualAt(
  bytes: Uint8Array,
  offset: number,
  expected: Uint8Array,
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

interface ParsedOggPage {
  readonly bodyOffset: number;
  readonly nextOffset: number;
  readonly summary: OggOpusPageSummary;
}

interface OggValidationState {
  expectedSerial: number | undefined;
  expectedSequence: number;
  firstBodyOffset: number;
  readonly pages: OggOpusPageSummary[];
  previousGranule: bigint;
  secondBodyOffset: number;
}

export function validateOggOpus(bytes: Uint8Array): OggOpusValidationResult {
  const state: OggValidationState = {
    expectedSequence: 0,
    expectedSerial: undefined,
    firstBodyOffset: 0,
    pages: [],
    previousGranule: 0n,
    secondBodyOffset: 0,
  };
  let offset = 0;
  while (offset < bytes.byteLength) {
    const page = parseOggPage(bytes, offset);
    acceptOggPage(state, page);
    offset = page.nextOffset;
  }
  assertOggOpusStructure(bytes, state);
  return { pages: state.pages, serial: state.expectedSerial ?? 0 };
}

function parseOggPage(bytes: Uint8Array, offset: number): ParsedOggPage {
  assertOggPageHeader(bytes, offset);
  const segmentCount = bytes[offset + 26];
  if (segmentCount === undefined || offset + 27 + segmentCount > bytes.byteLength) {
    throw new RecordingIngressError("corrupt-spool", "truncated Ogg lacing table");
  }
  const bodyLength = lacingBodyLength(bytes, offset, segmentCount);
  const pageLength = 27 + segmentCount + bodyLength;
  if (offset + pageLength > bytes.byteLength) {
    throw new RecordingIngressError("corrupt-spool", "truncated Ogg page body");
  }
  verifyPageChecksum(bytes, offset, pageLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, pageLength);
  return {
    bodyOffset: offset + 27 + segmentCount,
    nextOffset: offset + pageLength,
    summary: {
      bodyLength,
      granulePosition: view.getBigUint64(6, true),
      headerType: bytes[offset + 5] ?? 0,
      sequence: view.getUint32(18, true),
      serial: view.getUint32(14, true),
    },
  };
}

function assertOggPageHeader(bytes: Uint8Array, offset: number): void {
  if (offset + 27 > bytes.byteLength || !bytesEqualAt(bytes, offset, CAPTURE_PATTERN)) {
    throw new RecordingIngressError("corrupt-spool", "invalid Ogg page header");
  }
  if (bytes[offset + 4] !== 0) {
    throw new RecordingIngressError("corrupt-spool", "unsupported Ogg version");
  }
}

function lacingBodyLength(bytes: Uint8Array, offset: number, segmentCount: number): number {
  let bodyLength = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    bodyLength += bytes[offset + 27 + index] ?? 0;
  }
  return bodyLength;
}

function verifyPageChecksum(bytes: Uint8Array, offset: number, pageLength: number): void {
  // Buffer.slice() returns a view while Uint8Array.slice() returns a copy. The
  // validator accepts either, so force an owned copy before zeroing the CRC.
  const page = Uint8Array.from(bytes.subarray(offset, offset + pageLength));
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const storedCrc = view.getUint32(22, true);
  view.setUint32(22, 0, true);
  if (oggCrc32(page) !== storedCrc) {
    throw new RecordingIngressError("corrupt-spool", "Ogg CRC mismatch");
  }
}

function acceptOggPage(state: OggValidationState, page: ParsedOggPage): void {
  const { granulePosition, sequence, serial } = page.summary;
  if (state.expectedSerial === undefined) {
    state.expectedSerial = serial;
    state.firstBodyOffset = page.bodyOffset;
  } else if (serial !== state.expectedSerial) {
    throw new RecordingIngressError("corrupt-spool", "Ogg serial changed midstream");
  }
  if (sequence !== state.expectedSequence) {
    throw new RecordingIngressError("corrupt-spool", "Ogg page sequence is not contiguous");
  }
  if (granulePosition < state.previousGranule) {
    throw new RecordingIngressError("corrupt-spool", "Ogg granule position regressed");
  }
  if (state.expectedSequence === 1) {
    state.secondBodyOffset = page.bodyOffset;
  }
  state.pages.push(page.summary);
  state.previousGranule = granulePosition;
  state.expectedSequence += 1;
}

function assertOggOpusStructure(bytes: Uint8Array, state: OggValidationState): void {
  if (
    state.pages.length < 3 ||
    (state.pages[0]?.headerType ?? 0) !== 0x02 ||
    ((state.pages.at(-1)?.headerType ?? 0) & 0x04) === 0 ||
    !bytesEqualAt(bytes, state.firstBodyOffset, OPUS_HEAD) ||
    !bytesEqualAt(bytes, state.secondBodyOffset, OPUS_TAGS)
  ) {
    throw new RecordingIngressError("corrupt-spool", "invalid Ogg Opus structure");
  }
}
