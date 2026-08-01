import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";

import type {
  BinaryArtifactReader,
  BinaryArtifactReadRequest,
  BinaryArtifactReadResult,
} from "./contracts.js";
import {
  CHECKSUM_METADATA_KEY,
  SIZE_METADATA_KEY,
  assertChecksumSha256,
  assertContentType,
  assertSizeBytes,
  checksumHexToBase64,
  createOperationSignal,
  toByteChunks,
  validateUserMetadata,
  verifyByteStream,
} from "./content-validation.js";
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactOperationCancelledError,
  ArtifactStorageOperationError,
} from "./errors.js";
import {
  type S3ArtifactAccessPolicy,
  parseS3ArtifactLocator,
} from "./s3-artifact-locator.js";

export interface S3GetObjectClient {
  send(
    command: GetObjectCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<GetObjectCommandOutput>;
}

export interface S3BinaryArtifactReaderOptions {
  readonly accessPolicy: S3ArtifactAccessPolicy;
  readonly client: S3GetObjectClient;
  readonly expectedBucketOwner?: string;
  readonly operationTimeoutMs?: number;
}

function readRequiredMetadata(output: GetObjectCommandOutput): {
  readonly checksumSha256: string;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly sizeBytes: number;
} {
  const rawMetadata = output.Metadata ?? {};
  const rawChecksum = rawMetadata[CHECKSUM_METADATA_KEY];
  const rawMetadataSize = rawMetadata[SIZE_METADATA_KEY];
  if (rawChecksum === undefined) {
    throw new ArtifactIntegrityError("missing-checksum");
  }
  if (output.ContentLength === undefined || rawMetadataSize === undefined) {
    throw new ArtifactIntegrityError("missing-size");
  }
  if (output.ContentType === undefined) {
    throw new ArtifactIntegrityError("missing-content-type");
  }

  const checksumSha256 = assertChecksumSha256(rawChecksum);
  const contentLength = assertSizeBytes(output.ContentLength);
  const metadataSize = Number(rawMetadataSize);
  if (!Number.isSafeInteger(metadataSize) || metadataSize !== contentLength) {
    throw new ArtifactIntegrityError("size-mismatch");
  }

  const userMetadata = Object.fromEntries(
    Object.entries(rawMetadata).filter(
      ([key]) => key !== CHECKSUM_METADATA_KEY && key !== SIZE_METADATA_KEY,
    ),
  );
  return {
    checksumSha256,
    contentType: assertContentType(output.ContentType),
    metadata: validateUserMetadata(userMetadata),
    sizeBytes: contentLength,
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const named = "name" in error && error.name === "NoSuchKey";
  const status =
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata
      ? error.$metadata.httpStatusCode
      : undefined;
  return named || status === 404;
}

function ensureExpectedMetadata(
  actual: {
    readonly checksumSha256: string;
    readonly contentType: string;
    readonly sizeBytes: number;
  },
  expected: BinaryArtifactReadRequest["expected"],
): void {
  if (
    (expected?.checksumSha256 !== undefined &&
      assertChecksumSha256(expected.checksumSha256) !== actual.checksumSha256) ||
    (expected?.contentType !== undefined &&
      assertContentType(expected.contentType) !== actual.contentType) ||
    (expected?.sizeBytes !== undefined &&
      assertSizeBytes(expected.sizeBytes) !== actual.sizeBytes)
  ) {
    throw new ArtifactIntegrityError("invalid-metadata");
  }
}

async function* verifiedReadBody(
  body: unknown,
  descriptor: { readonly checksumSha256: string; readonly sizeBytes: number },
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  try {
    yield* verifyByteStream(toByteChunks(body), descriptor, signal);
  } catch (error) {
    if (
      error instanceof ArtifactIntegrityError ||
      error instanceof ArtifactOperationCancelledError
    ) {
      throw error;
    }
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new ArtifactOperationCancelledError({ cause: error });
    }
    throw new ArtifactStorageOperationError("read", { cause: error });
  }
}

export class S3BinaryArtifactReader implements BinaryArtifactReader {
  readonly #accessPolicy: S3ArtifactAccessPolicy;
  readonly #client: S3GetObjectClient;
  readonly #expectedBucketOwner: string | undefined;
  readonly #operationTimeoutMs: number;

  public constructor(options: S3BinaryArtifactReaderOptions) {
    this.#accessPolicy = options.accessPolicy;
    this.#client = options.client;
    this.#expectedBucketOwner = options.expectedBucketOwner;
    this.#operationTimeoutMs = options.operationTimeoutMs ?? 60_000;
  }

  public async read(
    request: BinaryArtifactReadRequest,
  ): Promise<BinaryArtifactReadResult> {
    const locator = parseS3ArtifactLocator(request.locator, this.#accessPolicy);
    const signal = createOperationSignal(
      request.signal,
      this.#operationTimeoutMs,
    );

    try {
      const command = new GetObjectCommand({
        Bucket: locator.bucket,
        ChecksumMode: "ENABLED",
        Key: locator.key,
        ...(this.#expectedBucketOwner === undefined
          ? {}
          : { ExpectedBucketOwner: this.#expectedBucketOwner }),
      });
      const output = await this.#client.send(command, { abortSignal: signal });
      if (output.Body === undefined) {
        throw new ArtifactIntegrityError("missing-body");
      }

      const descriptor = readRequiredMetadata(output);
      ensureExpectedMetadata(descriptor, request.expected);
      if (
        output.ChecksumType === "FULL_OBJECT" &&
        output.ChecksumSHA256 !== undefined &&
        output.ChecksumSHA256 !== checksumHexToBase64(descriptor.checksumSha256)
      ) {
        throw new ArtifactIntegrityError("checksum-mismatch");
      }

      return {
        body: verifiedReadBody(output.Body, descriptor, signal),
        checksumSha256: descriptor.checksumSha256,
        contentType: descriptor.contentType,
        ...(output.ETag === undefined ? {} : { eTag: output.ETag }),
        metadata: descriptor.metadata,
        sizeBytes: descriptor.sizeBytes,
        ...(output.VersionId === undefined
          ? {}
          : { versionId: output.VersionId }),
      };
    } catch (error) {
      if (
        error instanceof ArtifactIntegrityError ||
        error instanceof ArtifactNotFoundError ||
        error instanceof ArtifactOperationCancelledError
      ) {
        throw error;
      }
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new ArtifactOperationCancelledError({ cause: error });
      }
      if (isNotFound(error)) {
        throw new ArtifactNotFoundError({ cause: error });
      }
      throw new ArtifactStorageOperationError("read", { cause: error });
    }
  }
}

export function createS3BinaryArtifactReader(
  client: S3Client,
  options: Omit<S3BinaryArtifactReaderOptions, "client">,
): S3BinaryArtifactReader {
  return new S3BinaryArtifactReader({ ...options, client });
}
