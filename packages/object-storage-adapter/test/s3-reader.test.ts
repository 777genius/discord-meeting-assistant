import { createHash } from "node:crypto";

import { GetObjectCommand, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactOperationCancelledError,
  ArtifactStorageOperationError,
  S3BinaryArtifactReader,
  type S3GetObjectClient,
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
  return Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
}

function fakeClient(
  output: GetObjectCommandOutput,
  capture?: { command?: GetObjectCommand; signal?: AbortSignal },
): S3GetObjectClient {
  return {
    send: async (command, options) => {
      if (capture !== undefined) {
        capture.command = command;
        capture.signal = options.abortSignal;
      }
      return output;
    },
  };
}

function objectOutput(
  body: Uint8Array,
  overrides: Partial<GetObjectCommandOutput> = {},
): GetObjectCommandOutput {
  const output = {
    $metadata: {},
    Body: body as unknown,
    ContentLength: body.byteLength,
    ContentType: "audio/flac",
    ETag: '"etag-1"',
    Metadata: {
      "artifact-sha256": sha256(body),
      "artifact-size-bytes": String(body.byteLength),
      "speaker-id": "speaker-a",
    },
    VersionId: "version-1",
  } as unknown as GetObjectCommandOutput;
  return Object.assign(output, overrides);
}

describe("S3BinaryArtifactReader", () => {
  it("returns a stream that validates persisted size and checksum", async () => {
    const bytes = new TextEncoder().encode("verified speaker-a recording");
    const capture: { command?: GetObjectCommand; signal?: AbortSignal } = {};
    const reader = new S3BinaryArtifactReader({
      accessPolicy,
      client: fakeClient(objectOutput(bytes), capture),
      expectedBucketOwner: "123456789012",
    });

    const result = await reader.read({
      expected: {
        checksumSha256: sha256(bytes),
        contentType: "audio/flac",
        sizeBytes: bytes.byteLength,
      },
      locator,
    });

    await expect(collect(result.body)).resolves.toEqual(bytes);
    expect(result).toMatchObject({
      checksumSha256: sha256(bytes),
      contentType: "audio/flac",
      eTag: '"etag-1"',
      metadata: { "speaker-id": "speaker-a" },
      sizeBytes: bytes.byteLength,
      versionId: "version-1",
    });
    expect(capture.command?.input).toEqual({
      Bucket: "meeting-e2e-artifacts",
      ChecksumMode: "ENABLED",
      ExpectedBucketOwner: "123456789012",
      Key: "recordings/meeting-1/track-a.flac",
    });
  });

  it("detects body corruption while the caller drains the stream", async () => {
    const expectedBytes = new TextEncoder().encode("original bytes");
    const corruptedBytes = new TextEncoder().encode("changed! bytes");
    const output = objectOutput(corruptedBytes, {
      ContentLength: expectedBytes.byteLength,
      Metadata: {
        "artifact-sha256": sha256(expectedBytes),
        "artifact-size-bytes": String(expectedBytes.byteLength),
      },
    });
    const reader = new S3BinaryArtifactReader({
      accessPolicy,
      client: fakeClient(output),
    });

    const result = await reader.read({ locator });

    await expect(collect(result.body)).rejects.toMatchObject({
      failure: "checksum-mismatch",
    } satisfies Partial<ArtifactIntegrityError>);
  });

  it("rejects inconsistent persisted size before returning a body", async () => {
    const bytes = new TextEncoder().encode("audio");
    const reader = new S3BinaryArtifactReader({
      accessPolicy,
      client: fakeClient(
        objectOutput(bytes, {
          Metadata: {
            "artifact-sha256": sha256(bytes),
            "artifact-size-bytes": "999",
          },
        }),
      ),
    });

    await expect(reader.read({ locator })).rejects.toMatchObject({
      failure: "size-mismatch",
    } satisfies Partial<ArtifactIntegrityError>);
  });

  it("maps a provider 404 without exposing the object locator", async () => {
    const providerError = Object.assign(new Error("provider missing"), {
      $metadata: { httpStatusCode: 404 },
    });
    const client: S3GetObjectClient = {
      send: async () => Promise.reject(providerError),
    };
    const reader = new S3BinaryArtifactReader({ accessPolicy, client });

    await expect(reader.read({ locator })).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
      message: "artifact was not found",
    } satisfies Partial<ArtifactNotFoundError>);
  });

  it("passes caller cancellation to the S3 client", async () => {
    const controller = new AbortController();
    controller.abort();
    const client: S3GetObjectClient = {
      send: async (_command, options) => {
        if (options.abortSignal.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        throw new Error("unreachable");
      },
    };
    const reader = new S3BinaryArtifactReader({ accessPolicy, client });

    await expect(
      reader.read({ locator, signal: controller.signal }),
    ).rejects.toBeInstanceOf(ArtifactOperationCancelledError);
  });

  it("does not leak a raw provider stream failure", async () => {
    const bytes = new TextEncoder().encode("audio");
    async function* failingBody(): AsyncIterable<Uint8Array> {
      yield bytes;
      throw new Error("provider endpoint and request details");
    }
    const reader = new S3BinaryArtifactReader({
      accessPolicy,
      client: fakeClient(
        objectOutput(bytes, {
          Body: failingBody() as unknown as NonNullable<
            GetObjectCommandOutput["Body"]
          >,
        }),
      ),
    });

    const result = await reader.read({ locator });

    await expect(collect(result.body)).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_OPERATION_FAILED",
      message: "artifact read failed",
      operation: "read",
    } satisfies Partial<ArtifactStorageOperationError>);
  });
});
