const maximumOpusPacketDurationSamples = 5_760;

interface ExtractedOpusPacket {
  readonly durationSamples48Khz: number;
  readonly opus: Uint8Array;
  readonly relativeTimeMs: number;
}

export interface ExtractedOggOpus {
  readonly durationMs: number;
  readonly packets: readonly ExtractedOpusPacket[];
  readonly preSkipSamples48Khz: number;
}

interface OggPage {
  readonly bodyOffset: number;
  readonly bodySize: number;
  readonly granulePosition: bigint;
  readonly headerType: number;
  readonly lacing: readonly number[];
  readonly sequence: number;
  readonly serial: number;
}

export function extractOggOpusSpeechPackets(bytes: Uint8Array): ExtractedOggOpus {
  if (bytes.byteLength < 27) {
    throw new Error("Ogg Opus fixture is truncated");
  }
  const packets: Uint8Array[] = [];
  let packetParts: Uint8Array[] = [];
  let offset = 0;
  let expectedSequence = 0;
  let streamSerial: number | undefined;
  let finalGranule = 0n;
  let sawEos = false;

  while (offset < bytes.byteLength) {
    const page = parsePage(bytes, offset);
    if (streamSerial === undefined) {
      streamSerial = page.serial;
      if ((page.headerType & 0x02) === 0) {
        throw new Error("Ogg Opus fixture does not begin with a BOS page");
      }
    } else if (page.serial !== streamSerial) {
      throw new Error("Ogg Opus fixture contains multiple logical streams");
    }
    if (page.sequence !== expectedSequence) {
      throw new Error("Ogg Opus fixture has a discontinuous page sequence");
    }
    const continuesPacket = (page.headerType & 0x01) !== 0;
    if (continuesPacket !== (packetParts.length > 0)) {
      throw new Error("Ogg Opus fixture has inconsistent continuation flags");
    }
    if (sawEos) {
      throw new Error("Ogg Opus fixture contains data after its EOS page");
    }

    let cursor = page.bodyOffset;
    for (const length of page.lacing) {
      packetParts.push(bytes.slice(cursor, cursor + length));
      cursor += length;
      if (length < 255) {
        packets.push(concatenate(packetParts));
        packetParts = [];
      }
    }
    finalGranule = page.granulePosition;
    sawEos = (page.headerType & 0x04) !== 0;
    expectedSequence += 1;
    offset = page.bodyOffset + page.bodySize;
  }

  if (!sawEos || packetParts.length !== 0 || packets.length < 3) {
    throw new Error("Ogg Opus fixture has an incomplete packet stream");
  }
  const head = packets[0];
  const tags = packets[1];
  if (head === undefined || tags === undefined
    || ascii(head, 0, 8) !== "OpusHead" || ascii(tags, 0, 8) !== "OpusTags"
    || head.byteLength < 19 || head[8] !== 1 || (head[9] ?? 0) < 1) {
    throw new Error("Ogg fixture does not contain supported Opus headers");
  }
  const preSkipSamples48Khz = uint16le(head, 10);
  const audio = packets.slice(2);
  let samples = 0;
  const extracted = audio.map((opus) => {
    if (opus.byteLength === 0) {
      throw new Error("Ogg Opus fixture contains an empty speech packet");
    }
    const durationSamples48Khz = opusPacketDurationSamples(opus);
    const relativeTimeMs = samples / 48;
    samples += durationSamples48Khz;
    return Object.freeze({ durationSamples48Khz, opus, relativeTimeMs });
  });
  if (extracted.length === 0 || finalGranule <= BigInt(preSkipSamples48Khz)
    || finalGranule > BigInt(samples)) {
    throw new Error("Ogg Opus fixture has an invalid terminal granule position");
  }
  return Object.freeze({
    durationMs: Number(finalGranule - BigInt(preSkipSamples48Khz)) / 48,
    packets: Object.freeze(extracted),
    preSkipSamples48Khz,
  });
}

function parsePage(bytes: Uint8Array, offset: number): OggPage {
  if (offset + 27 > bytes.byteLength || ascii(bytes, offset, offset + 4) !== "OggS"
    || bytes[offset + 4] !== 0) {
    throw new Error("Ogg Opus fixture has an invalid page header");
  }
  const segmentCount = bytes[offset + 26] ?? -1;
  const bodyOffset = offset + 27 + segmentCount;
  if (segmentCount < 0 || bodyOffset > bytes.byteLength) {
    throw new Error("Ogg Opus fixture has invalid lacing");
  }
  const lacing = Array.from(bytes.slice(offset + 27, bodyOffset));
  const bodySize = lacing.reduce((total, length) => total + length, 0);
  if (bodyOffset + bodySize > bytes.byteLength) {
    throw new Error("Ogg Opus fixture has a truncated page body");
  }
  return {
    bodyOffset,
    bodySize,
    granulePosition: uint64le(bytes, offset + 6),
    headerType: bytes[offset + 5] ?? 0,
    lacing,
    sequence: uint32le(bytes, offset + 18),
    serial: uint32le(bytes, offset + 14),
  };
}

function opusPacketDurationSamples(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) {
    throw new Error("Opus packet is empty");
  }
  const configuration = toc >>> 3;
  const frameDuration = configuration >= 16
    ? 120 << (configuration & 0b11)
    : configuration >= 12
      ? 480 << (configuration & 0b1)
      : (configuration & 0b11) === 0b11
        ? 2_880
        : 480 << (configuration & 0b11);
  const frameCode = toc & 0b11;
  const frameCount = frameCode === 0 ? 1 : frameCode < 3 ? 2 : (packet[1] ?? 0) & 0x3f;
  const duration = frameDuration * frameCount;
  if (frameCount === 0 || duration > maximumOpusPacketDurationSamples) {
    throw new Error("Opus packet has an invalid frame duration");
  }
  return duration;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const combined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString("ascii");
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0)
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16)
    | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}

function uint64le(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
  }
  return value;
}
