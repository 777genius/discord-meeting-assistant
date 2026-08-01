import { Readable } from "node:stream";

import type { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import type {
  BinaryArtifactWriter,
  BinaryArtifactWriteReceipt,
  BinaryArtifactWriteRequest,
} from "./contracts.js";
import {
  CHECKSUM_METADATA_KEY,
  SIZE_METADATA_KEY,
  assertChecksumSha256,
  assertContentType,
  assertOperationActive,
  assertSizeBytes,
  createOperationSignal,
  toByteChunks,
  validateUserMetadata,
  verifyByteStream,
} from "./content-validation.js";
import {
  ArtifactIntegrityError,
  ArtifactOperationCancelledError,
  ArtifactStorageOperationError,
} from "./errors.js";
import {
  type S3ArtifactAccessPolicy,
  parseS3ArtifactLocator,
} from "./s3-artifact-locator.js";

export interface MultipartUploadResult {
  readonly checksumSha256?: string;
  readonly eTag?: string;
  readonly versionId?: string;
}

export interface MultipartUploadOperation {
  abort(): Promise<void>;
  done(): Promise<MultipartUploadResult>;
}

export interface MultipartUploadRequest {
  readonly body: AsyncIterable<Uint8Array>;
  readonly bucket: string;
  readonly contentType: string;
  readonly expectedBucketOwner?: string;
  readonly key: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly sizeBytes: number;
}

export interface MultipartUploadFactory {
  create(request: MultipartUploadRequest): MultipartUploadOperation;
}

export interface S3BinaryArtifactWriterOptions {
  readonly accessPolicy: S3ArtifactAccessPolicy;
  readonly expectedBucketOwner?: string;
  readonly multipartUploadFactory: MultipartUploadFactory;
  readonly operationTimeoutMs?: number;
}

export interface AwsMultipartUploadFactoryOptions {
  readonly client: S3Client;
  readonly partSizeBytes?: number;
  readonly queueSize?: number;
}

export function createAwsMultipartUploadFactory(
  options: AwsMultipartUploadFactoryOptions,
): MultipartUploadFactory {
  const partSizeBytes = options.partSizeBytes ?? 8 * 1_024 * 1_024;
  const queueSize = options.queueSize ?? 2;
  if (
    !Number.isSafeInteger(partSizeBytes) ||
    partSizeBytes < 5 * 1_024 * 1_024 ||
    !Number.isSafeInteger(queueSize) ||
    queueSize < 1
  ) {
    throw new ArtifactIntegrityError("invalid-metadata");
  }

  return {
    create(request): MultipartUploadOperation {
      const upload = new Upload({
        client: options.client,
        leavePartsOnError: false,
        params: {
          Body: Readable.from(request.body),
          Bucket: request.bucket,
          ChecksumAlgorithm: "SHA256",
          ContentLength: request.sizeBytes,
          ContentType: request.contentType,
          Key: request.key,
          Metadata: { ...request.metadata },
          ...(request.expectedBucketOwner === undefined
            ? {}
            : { ExpectedBucketOwner: request.expectedBucketOwner }),
        },
        partSize: partSizeBytes,
        queueSize,
      });

      return {
        abort: async () => upload.abort(),
        done: async () => {
          const result = await upload.done();
          return {
            ...(result.ChecksumSHA256 === undefined
              ? {}
              : { checksumSha256: result.ChecksumSHA256 }),
            ...(result.ETag === undefined ? {} : { eTag: result.ETag }),
            ...(result.VersionId === undefined
              ? {}
              : { versionId: result.VersionId }),
          };
        },
      };
    },
  };
}

export class S3BinaryArtifactWriter implements BinaryArtifactWriter {
  readonly #accessPolicy: S3ArtifactAccessPolicy;
  readonly #expectedBucketOwner: string | undefined;
  readonly #multipartUploadFactory: MultipartUploadFactory;
  readonly #operationTimeoutMs: number;

  public constructor(options: S3BinaryArtifactWriterOptions) {
    this.#accessPolicy = options.accessPolicy;
    this.#expectedBucketOwner = options.expectedBucketOwner;
    this.#multipartUploadFactory = options.multipartUploadFactory;
    this.#operationTimeoutMs = options.operationTimeoutMs ?? 15 * 60_000;
  }

  public async write(
    request: BinaryArtifactWriteRequest,
  ): Promise<BinaryArtifactWriteReceipt> {
    const locator = parseS3ArtifactLocator(request.locator, this.#accessPolicy);
    const checksumSha256 = assertChecksumSha256(request.checksumSha256);
    const contentType = assertContentType(request.contentType);
    const sizeBytes = assertSizeBytes(request.sizeBytes);
    const metadata = validateUserMetadata(request.metadata);
    const signal = createOperationSignal(
      request.signal,
      this.#operationTimeoutMs,
    );
    const body = verifyByteStream(
      toByteChunks(request.body),
      { checksumSha256, sizeBytes },
      signal,
    );
    const upload = this.#multipartUploadFactory.create({
      body,
      bucket: locator.bucket,
      contentType,
      ...(this.#expectedBucketOwner === undefined
        ? {}
        : { expectedBucketOwner: this.#expectedBucketOwner }),
      key: locator.key,
      metadata: {
        ...metadata,
        [CHECKSUM_METADATA_KEY]: checksumSha256,
        [SIZE_METADATA_KEY]: String(sizeBytes),
      },
      sizeBytes,
    });

    const abortUpload = (): void => {
      void upload.abort().catch(() => false);
    };
    signal.addEventListener("abort", abortUpload, { once: true });
    try {
      try {
        assertOperationActive(signal);
      } catch (error) {
        abortUpload();
        throw error;
      }
      const result = await upload.done();
      assertOperationActive(signal);
      return {
        checksumSha256,
        ...(result.eTag === undefined ? {} : { eTag: result.eTag }),
        locator: locator.canonical,
        sizeBytes,
        ...(result.versionId === undefined
          ? {}
          : { versionId: result.versionId }),
      };
    } catch (error) {
      abortUpload();
      if (
        error instanceof ArtifactIntegrityError ||
        error instanceof ArtifactOperationCancelledError
      ) {
        throw error;
      }
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new ArtifactOperationCancelledError({ cause: error });
      }
      throw new ArtifactStorageOperationError("write", { cause: error });
    } finally {
      signal.removeEventListener("abort", abortUpload);
    }
  }
}

export function createS3BinaryArtifactWriter(
  client: S3Client,
  options: Omit<S3BinaryArtifactWriterOptions, "multipartUploadFactory"> &
    Omit<AwsMultipartUploadFactoryOptions, "client">,
): S3BinaryArtifactWriter {
  const { partSizeBytes, queueSize, ...writerOptions } = options;
  return new S3BinaryArtifactWriter({
    ...writerOptions,
    multipartUploadFactory: createAwsMultipartUploadFactory({
      client,
      ...(partSizeBytes === undefined ? {} : { partSizeBytes }),
      ...(queueSize === undefined ? {} : { queueSize }),
    }),
  });
}
