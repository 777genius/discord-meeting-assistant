export interface MonoPcmS16Le16KhzAudio {
  /** The complete, bounded PCM output materialized in memory. */
  readonly bytes: Uint8Array;
  readonly channels: 1;
  readonly encoding: "pcm_s16le";
  readonly sampleRate: 16_000;
}

export interface PcmTranscodeOptions {
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
}

export interface CompleteOggToPcmTranscoder {
  /** Materializes the complete bounded PCM track before WebSocket upload begins. */
  transcode(
    completeOgg: Uint8Array,
    options: PcmTranscodeOptions,
  ): Promise<MonoPcmS16Le16KhzAudio>;
}
