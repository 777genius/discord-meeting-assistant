import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

export interface ObjectStorageBootstrapClient {
  send(command: unknown): Promise<unknown>;
}

function isAlreadyOwned(error: unknown): boolean {
  return typeof error === "object" && error !== null && (
    ("name" in error && error.name === "BucketAlreadyOwnedByYou") ||
    ("$metadata" in error && typeof error.$metadata === "object" &&
      error.$metadata !== null && "httpStatusCode" in error.$metadata &&
      error.$metadata.httpStatusCode === 409)
  );
}

function immutableRevision(output: unknown): string {
  if (
    typeof output !== "object" || output === null ||
    !("VersionId" in output) || typeof output.VersionId !== "string" ||
    output.VersionId.length === 0 || output.VersionId === "null"
  ) {
    throw new Error("object storage did not return an immutable version ID");
  }
  return output.VersionId;
}

export async function bootstrapVersionedBucket(
  client: ObjectStorageBootstrapClient,
  bucket: string,
): Promise<string> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (createError) {
      if (!isAlreadyOwned(createError)) {
        throw createError;
      }
    }
  }

  await client.send(new PutBucketVersioningCommand({
    Bucket: bucket,
    VersioningConfiguration: { Status: "Enabled" },
  }));
  const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  if (
    typeof versioning !== "object" || versioning === null ||
    !("Status" in versioning) || versioning.Status !== "Enabled"
  ) {
    throw new Error("object storage bucket versioning is not enabled");
  }

  const key = ".bootstrap/immutable-version-probe";
  const write = await client.send(new PutObjectCommand({
    Body: "immutable-version-probe",
    Bucket: bucket,
    ContentType: "text/plain",
    Key: key,
  }));
  const revision = immutableRevision(write);
  await client.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
    VersionId: revision,
  }));
  return revision;
}

async function secret(path: string | undefined, name: string): Promise<string> {
  if (path === undefined) {
    throw new Error(`${name} file is required`);
  }
  const value = (await readFile(path, "utf8")).trim();
  if (value.length === 0) {
    throw new Error(`${name} file is empty`);
  }
  return value;
}

async function runObjectStorageBootstrap(environment = process.env): Promise<void> {
  const bucket = environment.S3_BUCKET;
  const endpoint = environment.S3_ENDPOINT;
  const region = environment.S3_REGION;
  if (bucket === undefined || endpoint === undefined || region === undefined) {
    throw new Error("S3_BUCKET, S3_ENDPOINT, and S3_REGION are required");
  }
  const config: S3ClientConfig = {
    credentials: {
      accessKeyId: await secret(environment.S3_ACCESS_KEY_ID_FILE, "S3 access key"),
      secretAccessKey: await secret(environment.S3_SECRET_ACCESS_KEY_FILE, "S3 secret key"),
    },
    endpoint,
    forcePathStyle: true,
    region,
  };
  const client = new S3Client(config);
  try {
    await bootstrapVersionedBucket(client, bucket);
  } finally {
    client.destroy();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await runObjectStorageBootstrap();
}
