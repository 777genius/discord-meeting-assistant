import { describe, expect, it } from "vitest";

import {
  compileOggOpus,
  opusPacketDurationSamples,
  RecordingIngressError,
  validateOggOpus,
  type JournalPacket,
} from "../src/index.js";

const opus20Ms = Uint8Array.from([0xf8, 0xff, 0xfe]);

function packet(input: Partial<JournalPacket> = {}): JournalPacket {
  return {
    opus: opus20Ms,
    receivedAtMs: 1_000,
    relativeTimeMs: 0,
    rtpSequence: 65_534,
    rtpTimestamp: 0xffff_ff00,
    ...input,
  };
}

describe("Ogg Opus compiler", () => {
  it("produces deterministic valid pages and CRC values", () => {
    const packets = [
      packet(),
      packet({
        receivedAtMs: 1_020,
        relativeTimeMs: 20,
        rtpSequence: 65_535,
        rtpTimestamp: 0x0000_02c0,
      }),
    ];

    const first = compileOggOpus(
      "recording-1",
      "11111111111111111",
      packets,
    );
    const second = compileOggOpus(
      "recording-1",
      "11111111111111111",
      packets.toReversed(),
    );
    const validation = validateOggOpus(first.bytes);

    expect(first.bytes).toEqual(second.bytes);
    expect(first.durationMs).toBe(40);
    expect(validation.pages).toHaveLength(4);
    expect(validation.pages.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3]);
    expect(validation.pages.map(({ granulePosition }) => granulePosition)).toEqual([
      0n,
      0n,
      960n,
      1_920n,
    ]);
    expect(validation.pages[0]?.headerType).toBe(0x02);
    expect(validation.pages.at(-1)?.headerType).toBe(0x04);
  });

  it("does not mutate Buffer inputs while checking page CRC values", () => {
    const compiled = compileOggOpus(
      "recording-buffer-validation",
      "11111111111111111",
      [packet()],
    );
    const input = Buffer.from(compiled.bytes);
    const original = Buffer.from(input);

    validateOggOpus(input);

    expect(input).toEqual(original);
  });

  it("uses global timing across RTP wrap, delivery reordering and reconnect gaps", () => {
    const compiled = compileOggOpus(
      "recording-wrap",
      "11111111111111111",
      [
        packet({
          receivedAtMs: 6_000,
          relativeTimeMs: 5_000,
          rtpSequence: 10,
          rtpTimestamp: 100,
        }),
        packet({
          receivedAtMs: 1_040,
          relativeTimeMs: 40,
          rtpSequence: 0,
          rtpTimestamp: 0x0000_0680,
        }),
        packet(),
        packet({
          receivedAtMs: 1_020,
          relativeTimeMs: 20,
          rtpSequence: 65_535,
          rtpTimestamp: 0x0000_02c0,
        }),
      ],
    );
    const pages = validateOggOpus(compiled.bytes).pages;

    expect(pages.slice(2).map(({ granulePosition }) => granulePosition)).toEqual([
      960n,
      1_920n,
      2_880n,
      240_960n,
    ]);
    expect(compiled.timelineOffsetMs).toBe(0);
    expect(compiled.durationMs).toBe(5_020);
  });

  it("detects page corruption rather than returning an unverified asset", () => {
    const compiled = compileOggOpus(
      "recording-corrupt",
      "11111111111111111",
      [packet()],
    );
    const corrupted = compiled.bytes.slice();
    const finalByte = corrupted[corrupted.byteLength - 1];
    if (finalByte === undefined) {
      throw new Error("expected a non-empty Ogg fixture");
    }
    corrupted[corrupted.byteLength - 1] = finalByte ^ 0xff;

    expect(() => validateOggOpus(corrupted)).toThrow(
      expect.objectContaining({
        failure: "corrupt-spool",
      } satisfies Partial<RecordingIngressError>),
    );
  });

  it("rejects impossible Opus durations", () => {
    expect(opusPacketDurationSamples(opus20Ms)).toBe(960);
    expect(() => opusPacketDurationSamples(Uint8Array.from([0xfb, 0x3f]))).toThrow(
      expect.objectContaining({ failure: "invalid-input" }),
    );
  });
});
