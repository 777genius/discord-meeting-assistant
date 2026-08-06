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
} from "../application/recording-playback.js";

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
    readonly locator: string;
    readonly signal?: AbortSignal;
  }): Promise<RecordingPlaybackAudioDescriptor> {
    const descriptor = await this.head(input.locator, input.signal);
    return toPublicDescriptor(descriptor);
  }

  public async read(input: {
    readonly locator: string;
    readonly range?: RecordingPlaybackByteRange;
    readonly signal?: AbortSignal;
  }): Promise<RecordingPlaybackAudioReadResult> {
    const signal = operationSignal(input.signal, this.#operationTimeoutMs);
    const descriptor = await this.head(input.locator, signal);
    const range = input.range === undefined
      ? undefined
      : resolveByteRange(input.range, descriptor.sizeBytes);
    try {
      const output = await this.#client.send(
        new GetObjectCommand({
          Bucket: descriptor.locator.bucket,
          ...(descriptor.eTag === undefined ? {} : { IfMatch: descriptor.eTag }),
          Key: descriptor.locator.key,
          ...(range === undefined
            ? {}
            : { Range: `bytes=${range.start}-${range.end}` }),
        }),
        { abortSignal: signal },
      );
      if (output.Body === undefined) {
        throw new RecordingPlaybackAudioUnavailableError();
      }
      const contentLength = range === undefined
        ? descriptor.sizeBytes
        : range.end - range.start + 1;
      if (
        output.ContentLength !== undefined &&
        output.ContentLength !== contentLength
      ) {
        throw new RecordingPlaybackAudioUnavailableError();
      }
      return {
        body: toByteChunks(output),
        contentLength,
        contentType: descriptor.contentType,
        ...(descriptor.eTag === undefined ? {} : { eTag: descriptor.eTag }),
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
    rawLocator: string,
    outerSignal?: AbortSignal,
  ): Promise<ObjectDescriptor> {
    const locator = parseS3ArtifactLocator(rawLocator, this.#accessPolicy);
    const signal = operationSignal(outerSignal, this.#operationTimeoutMs);
    try {
      const output = await this.#client.send(
        new HeadObjectCommand({ Bucket: locator.bucket, Key: locator.key }),
        { abortSignal: signal },
      );
      return describeObject(locator, output);
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
  output: HeadObjectCommandOutput,
): ObjectDescriptor {
  const sizeBytes = output.ContentLength;
  const contentType = output.ContentType;
  if (
    sizeBytes === undefined ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    contentType === undefined ||
    !["application/ogg", "audio/ogg"].includes(contentType)
  ) {
    throw new RecordingPlaybackAudioUnavailableError();
  }
  return {
    contentType,
    ...(output.ETag === undefined ? {} : { eTag: output.ETag }),
    locator,
    sizeBytes,
  };
}

function toPublicDescriptor(
  descriptor: ObjectDescriptor,
): RecordingPlaybackAudioDescriptor {
  return {
    contentType: descriptor.contentType,
    ...(descriptor.eTag === undefined ? {} : { eTag: descriptor.eTag }),
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

async function* toByteChunks(
  output: GetObjectCommandOutput,
): AsyncIterable<Uint8Array> {
  const body = output.Body;
  if (body === undefined || !(Symbol.asyncIterator in Object(body))) {
    throw new RecordingPlaybackAudioUnavailableError();
  }
  for await (const chunk of body as AsyncIterable<unknown>) {
    if (chunk instanceof Uint8Array) {
      yield chunk;
      continue;
    }
    if (typeof chunk === "string") {
      yield Buffer.from(chunk);
      continue;
    }
    throw new RecordingPlaybackAudioUnavailableError();
  }
}
