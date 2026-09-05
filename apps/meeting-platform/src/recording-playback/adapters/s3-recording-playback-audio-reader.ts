import {
  GetObjectCommand,
  HeadObjectCommand,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  parseS3ArtifactLocator,
  type S3ArtifactAccessPolicy,
} from "@discord-meeting/object-storage-adapter";

import type {
  RecordingPlaybackAudioDescriptor,
  RecordingPlaybackAudioReader,
  RecordingPlaybackAudioReadResult,
  RecordingPlaybackByteRange,
  RecordingPlaybackTrack,
} from "../application/recording-playback.js";

const checksumMetadataKey = "artifact-sha256";
const sizeMetadataKey = "artifact-size-bytes";

export class RecordingPlaybackRangeNotSatisfiableError extends Error {
  public constructor(public readonly sizeBytes: number) {
    super("Recording playback byte range is not satisfiable");
    this.name = "RecordingPlaybackRangeNotSatisfiableError";
  }
}

export class RecordingPlaybackAudioUnavailableError extends Error {
  public constructor(options?: ErrorOptions) {
    super("Recording playback audio is unavailable", options);
    this.name = "RecordingPlaybackAudioUnavailableError";
  }
}

interface ObjectDescriptor extends RecordingPlaybackAudioDescriptor {
  readonly artifact: RecordingPlaybackTrack;
  readonly eTag: string;
  readonly locator: { readonly bucket: string; readonly key: string };
}

export class S3RecordingPlaybackAudioReader implements RecordingPlaybackAudioReader {
  readonly #accessPolicy: S3ArtifactAccessPolicy;
  readonly #client: S3Client;
  readonly #operationTimeoutMs: number;

  public constructor(input: {
    readonly accessPolicy: S3ArtifactAccessPolicy;
    readonly client: S3Client;
    readonly operationTimeoutMs?: number;
  }) {
    this.#accessPolicy = input.accessPolicy;
    this.#client = input.client;
    this.#operationTimeoutMs = input.operationTimeoutMs ?? 60_000;
  }

  public async describe(input: {
    readonly artifact: RecordingPlaybackTrack;
    readonly signal?: AbortSignal;
  }): Promise<RecordingPlaybackAudioDescriptor> {
    return toPublicDescriptor(await this.head(input.artifact, input.signal));
  }

  public async read(input: {
    readonly artifact: RecordingPlaybackTrack;
    readonly range?: RecordingPlaybackByteRange;
    readonly signal?: AbortSignal;
  }): Promise<RecordingPlaybackAudioReadResult> {
    const signal = operationSignal(input.signal, this.#operationTimeoutMs);
    const descriptor = await this.head(input.artifact, signal);
    const range = input.range === undefined
      ? undefined
      : resolveByteRange(input.range, descriptor.sizeBytes);
    try {
      const output = await this.#client.send(
        new GetObjectCommand({
          Bucket: descriptor.locator.bucket,
          ChecksumMode: "ENABLED",
          IfMatch: descriptor.eTag,
          Key: descriptor.locator.key,
          VersionId: descriptor.artifact.artifactRevision,
          ...(range === undefined ? {} : { Range: `bytes=${range.start}-${range.end}` }),
        }),
        { abortSignal: signal },
      );
      const contentLength = range === undefined
        ? descriptor.sizeBytes
        : range.end - range.start + 1;
      verifyGetObject(output, descriptor, contentLength, range);
      return {
        body: toByteChunks(output),
        contentLength,
        contentType: descriptor.contentType,
        eTag: descriptor.eTag,
        ...(range === undefined ? {} : { range }),
        sizeBytes: descriptor.sizeBytes,
      };
    } catch (error) {
      if (error instanceof RecordingPlaybackAudioUnavailableError) {
        throw error;
      }
      throw new RecordingPlaybackAudioUnavailableError({ cause: error });
    }
  }

  private async head(
    artifact: RecordingPlaybackTrack,
    outerSignal?: AbortSignal,
  ): Promise<ObjectDescriptor> {
    const locator = parseS3ArtifactLocator(artifact.audioLocator, this.#accessPolicy);
    const signal = operationSignal(outerSignal, this.#operationTimeoutMs);
    try {
      const output = await this.#client.send(
        new HeadObjectCommand({
          Bucket: locator.bucket,
          ChecksumMode: "ENABLED",
          Key: locator.key,
          VersionId: artifact.artifactRevision,
        }),
        { abortSignal: signal },
      );
      return describeObject(locator, artifact, output);
    } catch (error) {
      if (error instanceof RecordingPlaybackAudioUnavailableError) {
        throw error;
      }
      throw new RecordingPlaybackAudioUnavailableError({ cause: error });
    }
  }
}

function describeObject(
  locator: { readonly bucket: string; readonly key: string },
  artifact: RecordingPlaybackTrack,
  output: HeadObjectCommandOutput,
): ObjectDescriptor {
  const sizeBytes = output.ContentLength;
  const contentType = output.ContentType;
  const eTag = output.ETag;
  if (
    sizeBytes !== artifact.sizeBytes ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    contentType === undefined ||
    !["application/ogg", "audio/ogg"].includes(contentType) ||
    eTag === undefined ||
    eTag.trim().length === 0 ||
    output.VersionId !== artifact.artifactRevision ||
    !hasExpectedMetadata(output.Metadata, artifact) ||
    !hasExpectedChecksumHeader(output.ChecksumSHA256, artifact.checksumSha256)
  ) {
    throw new RecordingPlaybackAudioUnavailableError();
  }
  return { artifact, contentType, eTag, locator, sizeBytes };
}

function hasExpectedMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
  artifact: RecordingPlaybackTrack,
): boolean {
  return metadata?.[checksumMetadataKey] === artifact.checksumSha256 &&
    metadata[sizeMetadataKey] === String(artifact.sizeBytes);
}

function hasExpectedChecksumHeader(
  encodedChecksum: string | undefined,
  expectedChecksum: string,
): boolean {
  return encodedChecksum === undefined ||
    encodedChecksum === Buffer.from(expectedChecksum, "hex").toString("base64");
}

function verifyGetObject(
  output: GetObjectCommandOutput,
  descriptor: ObjectDescriptor,
  contentLength: number,
  range: { readonly end: number; readonly start: number } | undefined,
): void {
  const expectedContentRange = range === undefined
    ? undefined
    : `bytes ${range.start}-${range.end}/${descriptor.sizeBytes}`;
  if (
    output.Body === undefined ||
    output.VersionId !== descriptor.artifact.artifactRevision ||
    output.ContentLength !== contentLength ||
    output.ContentType !== descriptor.contentType ||
    !hasExpectedMetadata(output.Metadata, descriptor.artifact) ||
    !hasExpectedChecksumHeader(output.ChecksumSHA256, descriptor.artifact.checksumSha256) ||
    output.ContentRange !== expectedContentRange
  ) {
    throw new RecordingPlaybackAudioUnavailableError();
  }
}

function toPublicDescriptor(descriptor: ObjectDescriptor): RecordingPlaybackAudioDescriptor {
  return {
    contentType: descriptor.contentType,
    eTag: descriptor.eTag,
    sizeBytes: descriptor.sizeBytes,
  };
}

function operationSignal(
  outerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return outerSignal === undefined ? timeout : AbortSignal.any([outerSignal, timeout]);
}

function resolveByteRange(
  range: RecordingPlaybackByteRange,
  sizeBytes: number,
): { readonly end: number; readonly start: number } {
  if ("suffixLength" in range) {
    if (!Number.isSafeInteger(range.suffixLength) || range.suffixLength <= 0) {
      throw new RecordingPlaybackRangeNotSatisfiableError(sizeBytes);
    }
    return {
      end: sizeBytes - 1,
      start: Math.max(0, sizeBytes - range.suffixLength),
    };
  }
  if (
    !Number.isSafeInteger(range.start) ||
    range.start < 0 ||
    range.start >= sizeBytes ||
    (range.end !== undefined &&
      (!Number.isSafeInteger(range.end) || range.end < range.start))
  ) {
    throw new RecordingPlaybackRangeNotSatisfiableError(sizeBytes);
  }
  return {
    end: Math.min(range.end ?? sizeBytes - 1, sizeBytes - 1),
    start: range.start,
  };
}

async function* toByteChunks(output: GetObjectCommandOutput): AsyncIterable<Uint8Array> {
  const body = output.Body;
  if (body === undefined || !(Symbol.asyncIterator in Object(body))) {
    throw new RecordingPlaybackAudioUnavailableError();
  }
  for await (const chunk of body as AsyncIterable<unknown>) {
    if (chunk instanceof Uint8Array) {
      yield chunk;
    } else if (typeof chunk === "string") {
      yield Buffer.from(chunk);
    } else {
      throw new RecordingPlaybackAudioUnavailableError();
    }
  }
}
