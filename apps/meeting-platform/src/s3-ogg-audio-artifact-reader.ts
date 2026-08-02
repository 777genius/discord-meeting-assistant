import type { BinaryArtifactReader } from "@discord-meeting/object-storage-adapter";
import type {
  BinaryAudioArtifact,
  BinaryAudioArtifactReader,
  BinaryAudioReadOptions,
} from "@discord-meeting/speaches-adapter";
import type {
  CompleteOggArtifactReader,
  CompleteOggAudioArtifact,
  OggArtifactReadOptions,
} from "@discord-meeting/voicetext-adapter";

/**
 * Media-safe boundary for the V1 recorder output. Each speaker object is one
 * complete Ogg Opus stream, so it must never be split into arbitrary byte chunks.
 */
export class S3OggAudioArtifactReader implements BinaryAudioArtifactReader {
  public constructor(private readonly reader: BinaryArtifactReader) {}

  public async read(
    audioLocator: string,
    options: BinaryAudioReadOptions,
  ): Promise<BinaryAudioArtifact> {
    if (options.maxChunks < 1) {
      throw new RangeError("maxChunks must admit the complete Ogg track");
    }
    const bytes = await readCompleteOgg(
      this.reader,
      audioLocator,
      options.maxChunkBytes,
      options.signal,
    );

    return {
      chunks: [{ bytes, fileName: "speaker-track.ogg", mediaType: "audio/ogg", timelineOffsetMs: 0 }],
      providerTimestampOrigin: "recording-media-origin",
    };
  }
}

/** Provider-neutral object-storage bridge for the streaming transcription adapter. */
export class S3CompleteOggArtifactReader implements CompleteOggArtifactReader {
  public constructor(private readonly reader: BinaryArtifactReader) {}

  public async read(
    audioLocator: string,
    options: OggArtifactReadOptions,
  ): Promise<CompleteOggAudioArtifact> {
    return {
      bytes: await readCompleteOgg(
        this.reader,
        audioLocator,
        options.maxBytes,
        options.signal,
      ),
      complete: true,
      container: "ogg",
    };
  }
}

async function readCompleteOgg(
  reader: BinaryArtifactReader,
  audioLocator: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const artifact = await reader.read({ locator: audioLocator, signal });
  if (artifact.contentType !== "audio/ogg") {
    throw new TypeError("recording artifact must be Ogg audio");
  }
  if (artifact.sizeBytes < 1 || artifact.sizeBytes > maxBytes) {
    throw new RangeError("complete Ogg track exceeds the admitted byte limit");
  }

  const bytes = new Uint8Array(artifact.sizeBytes);
  let offset = 0;
  for await (const chunk of artifact.body) {
    signal.throwIfAborted();
    if (offset + chunk.byteLength > bytes.byteLength) {
      throw new RangeError("recording artifact exceeded its declared size");
    }
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== bytes.byteLength) {
    throw new RangeError("recording artifact ended before its declared size");
  }
  return bytes;
}
