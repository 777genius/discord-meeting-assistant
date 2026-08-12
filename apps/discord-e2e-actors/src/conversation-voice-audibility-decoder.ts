import {
  PCM_S16LE_CHANNELS,
  PCM_S16LE_SAMPLE_RATE_HERTZ,
  type ConversationVoiceOpusDecoder,
} from "./conversation-voice-observer.js";

export interface ConversationVoiceAudibilityDecoder extends ConversationVoiceOpusDecoder {
  isPacketAudible(opusPacket: Uint8Array): boolean;
}

class ProbedConversationVoiceOpusDecoder implements ConversationVoiceAudibilityDecoder {
  readonly #delegate: ConversationVoiceOpusDecoder;
  #probe: { readonly opusPacket: Uint8Array; readonly pcm: Uint8Array } | undefined;

  public constructor(delegate: ConversationVoiceOpusDecoder) {
    this.#delegate = delegate;
  }

  public decode(opusPacket: Uint8Array): Uint8Array {
    const probe = this.#probe;
    if (probe !== undefined && probe.opusPacket === opusPacket) {
      this.#probe = undefined;
      return probe.pcm;
    }
    this.#probe = undefined;
    return this.#delegate.decode(opusPacket);
  }

  public isPacketAudible(opusPacket: Uint8Array): boolean {
    const pcm = this.#delegate.decode(opusPacket);
    this.#probe = { opusPacket, pcm };
    return decodedPcmIsAudible(pcm);
  }
}

export async function createDiscordJsOpusDecoder(): Promise<ConversationVoiceAudibilityDecoder> {
  const opus = (await import("@discordjs/opus")).default;
  const decoder = new opus.OpusEncoder(
    PCM_S16LE_SAMPLE_RATE_HERTZ,
    PCM_S16LE_CHANNELS,
  );
  return new ProbedConversationVoiceOpusDecoder({
    decode: (opusPacket: Uint8Array) => decoder.decode(Buffer.from(opusPacket)),
  });
}

function decodedPcmIsAudible(pcm: Uint8Array): boolean {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error("Configured Craig audio decoder returned invalid PCM");
  }
  const data = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sampleCount = 0;
  let sampleSquareSum = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += 2) {
    const sample = data.getInt16(offset, true);
    sampleCount += 1;
    sampleSquareSum += sample * sample;
  }
  return Math.sqrt(sampleSquareSum / sampleCount) / 32_768 >= 0.01;
}
