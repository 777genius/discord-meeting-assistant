import {
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import {
  RecordingPlaybackAudioUnavailableError,
  RecordingPlaybackRangeNotSatisfiableError,
  S3RecordingPlaybackAudioReader,
} from "../src/recording-playback/adapters/s3-recording-playback-audio-reader.js";

const locator = "s3://meeting-artifacts/recordings/private/a.ogg";
const artifact = {
  artifactRevision: "version-1",
  audioLocator: locator,
  checksumSha256: "a".repeat(64),
  sizeBytes: 10,
  timelineOffsetMs: 0,
};
const metadata = {
  "artifact-sha256": artifact.checksumSha256,
  "artifact-size-bytes": String(artifact.sizeBytes),
};
const head = {
  ContentLength: 10,
  ContentType: "audio/ogg",
  ETag: '"etag-1"',
  Metadata: metadata,
  VersionId: artifact.artifactRevision,
};

function readerWith(send: ReturnType<typeof vi.fn>) {
  return new S3RecordingPlaybackAudioReader({
    accessPolicy: { bucket: "meeting-artifacts", keyPrefix: "recordings/" },
    client: { send } as unknown as S3Client,
  });
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<number[]> {
  const bytes: number[] = [];
  for await (const chunk of body) {
    bytes.push(...chunk);
  }
  return bytes;
}

describe("S3RecordingPlaybackAudioReader", () => {
  it("binds HEAD and ranged GET to the DB-pinned version", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return head;
      }
      if (command instanceof GetObjectCommand) {
        return {
          Body: (async function* () {
            yield Uint8Array.of(2, 3, 4, 5);
          })(),
          ContentLength: 4,
          ContentRange: "bytes 2-5/10",
          ContentType: "audio/ogg",
          Metadata: metadata,
          VersionId: "version-1",
        };
      }
      throw new Error("unexpected command");
    });
    const reader = readerWith(send);

    const result = await reader.read({ artifact, range: { end: 5, start: 2 } });

    expect(await collect(result.body)).toEqual([2, 3, 4, 5]);
    expect((send.mock.calls[0]![0] as HeadObjectCommand).input).toMatchObject({
      ChecksumMode: "ENABLED",
      VersionId: "version-1",
    });
    expect((send.mock.calls[1]![0] as GetObjectCommand).input).toMatchObject({
      IfMatch: '"etag-1"',
      Range: "bytes=2-5",
      VersionId: "version-1",
    });
  });

  it("keeps serving the pinned version after the mutable key is overwritten", async () => {
    const requestedVersions: (string | undefined)[] = [];
    const send = vi.fn(async (command: HeadObjectCommand | GetObjectCommand) => {
      requestedVersions.push(command.input.VersionId);
      if (command instanceof HeadObjectCommand) {
        return head;
      }
      return {
        Body: (async function* () {
          yield Uint8Array.from({ length: 10 }, () => 1);
        })(),
        ContentLength: 10,
        ContentType: "audio/ogg",
        Metadata: metadata,
        VersionId: "version-1",
      };
    });
    const reader = readerWith(send);

    await collect((await reader.read({ artifact })).body);

    expect(requestedVersions).toEqual(["version-1", "version-1"]);
  });

  it.each([
    ["revision", { ...head, VersionId: "version-2" }],
    ["checksum", { ...head, Metadata: { ...metadata, "artifact-sha256": "b".repeat(64) } }],
    ["metadata size", { ...head, Metadata: { ...metadata, "artifact-size-bytes": "9" } }],
    ["exact size", { ...head, ContentLength: 9 }],
    ["missing identity", { ContentLength: 10, ContentType: "audio/ogg", ETag: '"etag-1"' }],
  ])("fails closed on %s mismatch", async (_reason, descriptor) => {
    const reader = readerWith(vi.fn(async () => descriptor));
    await expect(reader.describe({ artifact }))
      .rejects.toBeInstanceOf(RecordingPlaybackAudioUnavailableError);
  });

  it("fails closed when GET returns another version or incomplete identity", async () => {
    const send = vi.fn(async (command: unknown) => command instanceof HeadObjectCommand
      ? head
      : {
          Body: (async function* () {
            yield Uint8Array.of(1);
          })(),
          ContentLength: 10,
          ContentType: "audio/ogg",
          Metadata: metadata,
          VersionId: "version-2",
        });
    await expect(readerWith(send).read({ artifact }))
      .rejects.toBeInstanceOf(RecordingPlaybackAudioUnavailableError);
  });

  it("resolves ranges against the DB-bound exact size", async () => {
    const send = vi.fn(async () => head);
    const reader = readerWith(send);
    await expect(reader.read({ artifact, range: { start: 10 } }))
      .rejects.toEqual(expect.objectContaining({
        name: RecordingPlaybackRangeNotSatisfiableError.name,
        sizeBytes: 10,
      }));
    expect(send).toHaveBeenCalledOnce();
  });
});
