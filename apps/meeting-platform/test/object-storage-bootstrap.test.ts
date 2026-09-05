import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import {
  bootstrapVersionedBucket,
  type ObjectStorageBootstrapClient,
} from "../src/composition/object-storage-bootstrap.js";

class BootstrapClient implements ObjectStorageBootstrapClient {
  public readonly commands: unknown[] = [];
  public bucketExists = false;
  public versionId: string | undefined = "immutable-version-1";

  public send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    if (command instanceof HeadBucketCommand && !this.bucketExists) {
      return Promise.reject(Object.assign(new Error("missing"), { name: "NotFound" }));
    }
    if (command instanceof CreateBucketCommand) {
      this.bucketExists = true;
    }
    if (command instanceof GetBucketVersioningCommand) {
      return Promise.resolve({ Status: "Enabled" });
    }
    if (command instanceof PutObjectCommand) {
      return Promise.resolve({ VersionId: this.versionId });
    }
    return Promise.resolve({});
  }
}

describe("object storage bootstrap", () => {
  it("idempotently creates a versioned bucket and proves writes have an immutable revision", async () => {
    const client = new BootstrapClient();

    await expect(bootstrapVersionedBucket(client, "meeting-artifacts"))
      .resolves.toBe("immutable-version-1");
    await expect(bootstrapVersionedBucket(client, "meeting-artifacts"))
      .resolves.toBe("immutable-version-1");

    expect(client.commands.filter((command) => command instanceof CreateBucketCommand))
      .toHaveLength(1);
    expect(client.commands.filter((command) => command instanceof PutBucketVersioningCommand))
      .toHaveLength(2);
    expect(client.commands.filter((command) => command instanceof DeleteObjectCommand))
      .toHaveLength(2);
    expect((client.commands.find((command) => command instanceof DeleteObjectCommand) as DeleteObjectCommand).input)
      .toMatchObject({ Bucket: "meeting-artifacts", VersionId: "immutable-version-1" });
  });

  it("fails closed when a versioned write has no immutable revision", async () => {
    const client = new BootstrapClient();
    client.bucketExists = true;
    client.versionId = undefined;

    await expect(bootstrapVersionedBucket(client, "meeting-artifacts"))
      .rejects.toThrow("immutable version ID");
    expect(client.commands.some((command) => command instanceof DeleteObjectCommand)).toBe(false);
  });
});
