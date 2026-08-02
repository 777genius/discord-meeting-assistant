export interface CompleteOggAudioArtifact {
  readonly bytes: Uint8Array;
  readonly complete: true;
  readonly container: "ogg";
}

export interface OggArtifactReadOptions {
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

/** Reads one complete, authoritative speaker track from its artifact locator. */
export interface CompleteOggArtifactReader {
  read(
    audioLocator: string,
    options: OggArtifactReadOptions,
  ): Promise<CompleteOggAudioArtifact>;
}
