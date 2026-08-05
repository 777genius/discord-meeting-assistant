import type { LivePacketInspector } from "./contracts.js";

const maximumOpusPacketDurationSamples = 5_760;

/**
 * Protocol-only Opus duration inspection. Keeping it here avoids coupling the
 * derived transcription path to the authoritative recording adapter.
 */
function durationSamples48Khz(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) {
    throw new RangeError("Opus packet is empty");
  }
  const config = toc >>> 3;
  const frameDurationSamples = frameDuration(config);
  const frameCount = countFrames(packet, toc);
  const duration = frameDurationSamples * frameCount;
  if (duration > maximumOpusPacketDurationSamples) {
    throw new RangeError("Opus packet duration exceeds 120 ms");
  }
  return duration;
}

function frameDuration(config: number): number {
  if (config >= 16) {
    return 120 << (config & 0b11);
  }
  if (config >= 12) {
    return 480 << (config & 0b1);
  }
  if ((config & 0b11) === 0b11) {
    return 2_880;
  }
  return 480 << (config & 0b11);
}

function countFrames(packet: Uint8Array, toc: number): number {
  const frameCode = toc & 0b11;
  if (frameCode === 0) {
    return 1;
  }
  if (frameCode === 1 || frameCode === 2) {
    return 2;
  }
  const countByte = packet[1];
  if (countByte === undefined) {
    throw new RangeError("Opus packet omits its frame count");
  }
  const frameCount = countByte & 0x3f;
  if (frameCount === 0) {
    throw new RangeError("Opus packet declares zero frames");
  }
  return frameCount;
}

export const defaultLivePacketInspector: LivePacketInspector = Object.freeze({
  durationSamples48Khz,
});
