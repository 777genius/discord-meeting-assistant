import type { BinaryArtifactReader } from "@discord-meeting/object-storage-adapter";
import type {
  BinaryAudioArtifact,
  BinaryAudioArtifactReader,
  BinaryAudioReadOptions,
} from "@discord-meeting/speaches-adapter";

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
    options.signal.throwIfAborted();
    if (options.maxChunks < 1) {
      throw new RangeError("maxChunks must admit the complete Ogg track");
    }

    const artifact = await this.reader.read({ locator: audioLocator, signal: options.signal });
    if (artifact.contentType !== "audio/ogg") {
      throw new TypeError("recording artifact must be Ogg audio");
    }
    if (artifact.sizeBytes < 1 || artifact.sizeBytes > options.maxChunkBytes) {
      throw new RangeError("complete Ogg track exceeds the admitted chunk size");
    }

    const bytes = new Uint8Array(artifact.sizeBytes);
    let offset = 0;
    for await (const chunk of artifact.body) {
      options.signal.throwIfAborted();
      if (offset + chunk.byteLength > bytes.byteLength) {
        throw new RangeError("recording artifact exceeded its declared size");
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== bytes.byteLength) {
      throw new RangeError("recording artifact ended before its declared size");
    }

    return {
      chunks: [{ bytes, fileName: "speaker-track.ogg", mediaType: "audio/ogg", timelineOffsetMs: 0 }],
    };
  }
}
