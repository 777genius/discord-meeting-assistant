import { AsyncLocalStorage } from "node:async_hooks";

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

export class ImmutableArtifactIdentityError extends Error {
  public constructor() {
    super("authoritative recording lacks a complete immutable artifact identity");
    this.name = "ImmutableArtifactIdentityError";
  }
}

type ImmutableArtifactExpectation = {
  readonly checksumSha256: string;
  readonly revision: string;
  readonly sizeBytes: number;
};

interface ImmutableRecordingArtifactIdentity {
  readonly speakerAudio: readonly {
    readonly [key: string]: unknown;
    readonly artifactRevision?: string;
    readonly audioLocator: string;
    readonly checksumSha256?: string;
    readonly sizeBytes?: number;
  }[];
}

export class ImmutableArtifactReadScope {
  readonly #storage = new AsyncLocalStorage<ReadonlyMap<string, ImmutableArtifactExpectation>>();

  public run<Value>(
    recording: ImmutableRecordingArtifactIdentity,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const expectations = new Map<string, ImmutableArtifactExpectation>();
    for (const reference of recording.speakerAudio) {
      if (
        reference.artifactRevision === undefined ||
        reference.checksumSha256 === undefined ||
        reference.sizeBytes === undefined
      ) {
        throw new ImmutableArtifactIdentityError();
      }
      expectations.set(reference.audioLocator, {
        checksumSha256: reference.checksumSha256,
        revision: reference.artifactRevision,
        sizeBytes: reference.sizeBytes,
      });
    }
    return this.#storage.run(expectations, operation);
  }

  public request(locator: string, signal: AbortSignal) {
    const expectation = this.#storage.getStore()?.get(locator);
    if (expectation === undefined) {
      throw new ImmutableArtifactIdentityError();
    }
    return {
      expected: {
        checksumSha256: expectation.checksumSha256,
        contentType: "audio/ogg",
        sizeBytes: expectation.sizeBytes,
      },
      locator,
      revision: expectation.revision,
      signal,
    } as const;
  }
}

/**
 * Media-safe boundary for the V1 recorder output. Each speaker object is one
 * complete Ogg Opus stream, so it must never be split into arbitrary byte chunks.
 */
export class S3OggAudioArtifactReader implements BinaryAudioArtifactReader {
  public constructor(
    private readonly reader: BinaryArtifactReader,
    private readonly scope: ImmutableArtifactReadScope,
  ) {}

  public async read(
    audioLocator: string,
    options: BinaryAudioReadOptions,
  ): Promise<BinaryAudioArtifact> {
    if (options.maxChunks < 1) {
      throw new RangeError("maxChunks must admit the complete Ogg track");
    }
    const bytes = await readCompleteOgg(
      this.reader,
      this.scope,
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
  public constructor(
    private readonly reader: BinaryArtifactReader,
    private readonly scope: ImmutableArtifactReadScope,
  ) {}

  public async read(
    audioLocator: string,
    options: OggArtifactReadOptions,
  ): Promise<CompleteOggAudioArtifact> {
    return {
      bytes: await readCompleteOgg(
        this.reader,
        this.scope,
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
  scope: ImmutableArtifactReadScope,
  audioLocator: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const artifact = await reader.read(scope.request(audioLocator, signal));
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
