import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ArtifactIntegrityError,
  ArtifactOperationCancelledError,
  S3BinaryArtifactWriter,
  type MultipartUploadFactory,
  type MultipartUploadRequest,
} from "../src/index.js";

const locator =
  "s3://meeting-e2e-artifacts/recordings/meeting-1/track-a.flac";
const accessPolicy = {
  bucket: "meeting-e2e-artifacts",
  keyPrefix: "recordings/",
} as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function consumingUploadFactory(capture: {
  aborted: boolean;
  request?: MultipartUploadRequest;
}): MultipartUploadFactory {
  return {
    create(request) {
      capture.request = request;
      return {
        abort: async () => {
          capture.aborted = true;
        },
        done: async () => {
          await collect(request.body);
          return { eTag: '"etag-1"', versionId: "version-1" };
        },
      };
    },
  };
}

describe("S3BinaryArtifactWriter", () => {
  it("uploads a verified stream with immutable integrity metadata", async () => {
    const bytes = new TextEncoder().encode("speaker-a audio fixture");
    const capture: { aborted: boolean; request?: MultipartUploadRequest } = {
      aborted: false,
    };
    const writer = new S3BinaryArtifactWriter({
      accessPolicy,
      expectedBucketOwner: "123456789012",
      multipartUploadFactory: consumingUploadFactory(capture),
    });

    await expect(
      writer.write({
        body: bytes,
        checksumSha256: sha256(bytes),
        contentType: "audio/flac",
        locator,
        metadata: { "meeting-id": "meeting-1", "speaker-id": "speaker-a" },
        sizeBytes: bytes.byteLength,
      }),
    ).resolves.toEqual({
      checksumSha256: sha256(bytes),
      eTag: '"etag-1"',
      locator,
      sizeBytes: bytes.byteLength,
      versionId: "version-1",
    });
    expect(capture.aborted).toBe(false);
    expect(capture.request).toMatchObject({
      bucket: "meeting-e2e-artifacts",
      contentType: "audio/flac",
      expectedBucketOwner: "123456789012",
      key: "recordings/meeting-1/track-a.flac",
      metadata: {
        "artifact-sha256": sha256(bytes),
        "artifact-size-bytes": String(bytes.byteLength),
        "meeting-id": "meeting-1",
        "speaker-id": "speaker-a",
      },
      sizeBytes: bytes.byteLength,
    });
  });

  it("fails the upload when the streamed checksum is wrong", async () => {
    const bytes = new TextEncoder().encode("corrupted recording");
    const capture: { aborted: boolean; request?: MultipartUploadRequest } = {
      aborted: false,
    };
    const writer = new S3BinaryArtifactWriter({
      accessPolicy,
      multipartUploadFactory: consumingUploadFactory(capture),
    });

    await expect(
      writer.write({
        body: bytes,
        checksumSha256: "0".repeat(64),
        contentType: "audio/flac",
        locator,
        sizeBytes: bytes.byteLength,
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_FAILURE",
      failure: "checksum-mismatch",
    } satisfies Partial<ArtifactIntegrityError>);
    expect(capture.aborted).toBe(true);
  });

  it("fails the upload when the stream exceeds its declared size", async () => {
    const bytes = new TextEncoder().encode("too many bytes");
    const capture: { aborted: boolean; request?: MultipartUploadRequest } = {
      aborted: false,
    };
    const writer = new S3BinaryArtifactWriter({
      accessPolicy,
      multipartUploadFactory: consumingUploadFactory(capture),
    });

    await expect(
      writer.write({
        body: bytes,
        checksumSha256: sha256(bytes),
        contentType: "audio/flac",
        locator,
        sizeBytes: bytes.byteLength - 1,
      }),
    ).rejects.toMatchObject({
      failure: "size-mismatch",
    } satisfies Partial<ArtifactIntegrityError>);
  });

  it("aborts multipart work when the caller is already cancelled", async () => {
    const bytes = new Uint8Array();
    const controller = new AbortController();
    controller.abort();
    const capture: { aborted: boolean; request?: MultipartUploadRequest } = {
      aborted: false,
    };
    const writer = new S3BinaryArtifactWriter({
      accessPolicy,
      multipartUploadFactory: consumingUploadFactory(capture),
    });

    await expect(
      writer.write({
        body: bytes,
        checksumSha256: sha256(bytes),
        contentType: "application/octet-stream",
        locator,
        signal: controller.signal,
        sizeBytes: 0,
      }),
    ).rejects.toBeInstanceOf(ArtifactOperationCancelledError);
    expect(capture.aborted).toBe(true);
  });

  it("rejects attempts to override reserved integrity metadata", async () => {
    const bytes = new Uint8Array();
    const writer = new S3BinaryArtifactWriter({
      accessPolicy,
      multipartUploadFactory: consumingUploadFactory({ aborted: false }),
    });

    await expect(
      writer.write({
        body: bytes,
        checksumSha256: sha256(bytes),
        contentType: "application/octet-stream",
        locator,
        metadata: { "artifact-sha256": "malicious" },
        sizeBytes: 0,
      }),
    ).rejects.toMatchObject({
      failure: "invalid-metadata",
    } satisfies Partial<ArtifactIntegrityError>);
  });
});
