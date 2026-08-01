import { createHash } from "node:crypto";

import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";

import {
  createS3BinaryArtifactReader,
  createS3BinaryArtifactWriter,
} from "../src/index.js";

const integrationEnabled = process.env.RUN_OBJECT_STORAGE_INTEGRATION === "1";
const endpoint =
  process.env.OBJECT_STORAGE_INTEGRATION_ENDPOINT ?? "http://127.0.0.1:18333";
const bucket = "meeting-e2e-artifacts";
const key = "recordings/integration/multipart-fixture.bin";
const locator = `s3://${bucket}/${key}`;

const client = new S3Client({
  credentials: {
    accessKeyId: "meeting-e2e-access",
    secretAccessKey: "meeting-e2e-secret",
  },
  endpoint,
  forcePathStyle: true,
  region: "us-east-1",
});

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

describe.skipIf(!integrationEnabled)("S3 adapter against disposable SeaweedFS", () => {
  afterAll(async () => {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    client.destroy();
  });

  it(
    "round-trips a multipart object with integrity metadata",
    async () => {
      const bytes = new Uint8Array(6 * 1_024 * 1_024 + 17);
      for (let index = 0; index < bytes.byteLength; index += 1) {
        bytes[index] = index % 251;
      }
      const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
      const accessPolicy = { bucket, keyPrefix: "recordings/" } as const;
      const writer = createS3BinaryArtifactWriter(client, {
        accessPolicy,
        operationTimeoutMs: 30_000,
        partSizeBytes: 5 * 1_024 * 1_024,
        queueSize: 1,
      });
      const reader = createS3BinaryArtifactReader(client, {
        accessPolicy,
        operationTimeoutMs: 30_000,
      });

      await expect(
        writer.write({
          body: bytes,
          checksumSha256,
          contentType: "application/octet-stream",
          locator,
          metadata: { "fixture-kind": "multipart" },
          sizeBytes: bytes.byteLength,
        }),
      ).resolves.toMatchObject({
        checksumSha256,
        locator,
        sizeBytes: bytes.byteLength,
      });

      const artifact = await reader.read({
        expected: {
          checksumSha256,
          contentType: "application/octet-stream",
          sizeBytes: bytes.byteLength,
        },
        locator,
      });

      await expect(collect(artifact.body)).resolves.toEqual(bytes);
      expect(artifact.metadata).toEqual({ "fixture-kind": "multipart" });
    },
    60_000,
  );
});
