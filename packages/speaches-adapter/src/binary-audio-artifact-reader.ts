export interface BinaryAudioChunk {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mediaType: string;
  /** Offset of this media-safe chunk within its speaker track. */
  readonly timelineOffsetMs: number;
}

export interface BinaryAudioArtifact {
  readonly chunks: readonly BinaryAudioChunk[];
}

export interface BinaryAudioReadOptions {
  readonly maxChunkBytes: number;
  readonly maxChunks: number;
  readonly signal: AbortSignal;
}

/**
 * Resolves an authoritative recording locator into complete, independently
 * decodable chunks. Chunking/transcoding belongs to the artifact boundary, not
 * to the transcription provider adapter.
 */
export interface BinaryAudioArtifactReader {
  read(
    audioLocator: string,
    options: BinaryAudioReadOptions,
  ): Promise<BinaryAudioArtifact>;
}
