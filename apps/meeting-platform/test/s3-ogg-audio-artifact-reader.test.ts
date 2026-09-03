import type { BinaryArtifactReader, BinaryArtifactReadRequest } from "@discord-meeting/object-storage-adapter";
import { describe, expect, it } from "vitest";

import {
  ImmutableArtifactReadScope,
  S3CompleteOggArtifactReader,
  S3OggAudioArtifactReader,
} from "../src/adapters/outbound/s3-ogg-audio-artifact-reader.js";

function artifactReader(
  bytes: Uint8Array,
  contentType = "audio/ogg",
  capture?: { request?: BinaryArtifactReadRequest },
): BinaryArtifactReader {
  return {
    read: async (request) => {
      if (capture !== undefined) {capture.request = request;}
      return ({
      body: (async function* () {
        yield bytes.slice(0, 2);
        yield bytes.slice(2);
      })(),
      checksumSha256: "a".repeat(64),
      contentType,
      metadata: {},
      sizeBytes: bytes.byteLength,
      });
    },
  };
}

function inImmutableScope<Value>(scope: ImmutableArtifactReadScope, locator: string, sizeBytes: number, operation: () => Promise<Value>): Promise<Value> {
  return scope.run({
    speakerAudio: [{
      artifactRevision: "version-1",
      audioLocator: locator,
      checksumSha256: "a".repeat(64),
      sizeBytes,
    }],
  }, operation);
}

describe("S3 Ogg audio artifact reader", () => {
  it("drains one verified object as one media-safe Ogg chunk", async () => {
    const scope = new ImmutableArtifactReadScope();
    const capture: { request?: BinaryArtifactReadRequest } = {};
    const reader = new S3OggAudioArtifactReader(
      artifactReader(Uint8Array.from([1, 2, 3, 4]), "audio/ogg", capture),
      scope,
    );

    await expect(
      inImmutableScope(scope, "s3://meeting/recordings/speaker.ogg", 4, async () =>
        await reader.read("s3://meeting/recordings/speaker.ogg", {
          maxChunkBytes: 64,
          maxChunks: 1,
          signal: new AbortController().signal,
        }),
      ),
    ).resolves.toEqual({
      chunks: [{
        bytes: Uint8Array.from([1, 2, 3, 4]),
        fileName: "speaker-track.ogg",
        mediaType: "audio/ogg",
        timelineOffsetMs: 0,
      }],
      providerTimestampOrigin: "recording-media-origin",
    });
    expect(capture.request).toEqual({
      expected: { checksumSha256: "a".repeat(64), contentType: "audio/ogg", sizeBytes: 4 },
      locator: "s3://meeting/recordings/speaker.ogg",
      revision: "version-1",
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects non-Ogg artifacts and arbitrary byte splitting", async () => {
    const scope = new ImmutableArtifactReadScope();
    const reader = new S3OggAudioArtifactReader(
      artifactReader(Uint8Array.from([1, 2, 3]), "audio/mpeg"),
      scope,
    );

    await expect(
      inImmutableScope(scope, "s3://meeting/recordings/speaker.mp3", 3, async () =>
        await reader.read("s3://meeting/recordings/speaker.mp3", {
          maxChunkBytes: 64,
          maxChunks: 1,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toThrow("must be Ogg");
  });

  it("exposes the same complete Ogg through the Voicetext reader port", async () => {
    const scope = new ImmutableArtifactReadScope();
    const reader = new S3CompleteOggArtifactReader(
      artifactReader(Uint8Array.from([79, 103, 103, 83, 1, 2])),
      scope,
    );

    await expect(
      inImmutableScope(scope, "s3://meeting/recordings/speaker.ogg", 6, async () =>
        await reader.read("s3://meeting/recordings/speaker.ogg", {
          maxBytes: 64,
          signal: new AbortController().signal,
        }),
      ),
    ).resolves.toEqual({
      bytes: Uint8Array.from([79, 103, 103, 83, 1, 2]),
      complete: true,
      container: "ogg",
    });
  });

  it("fails closed outside an immutable recording scope", async () => {
    const reader = new S3CompleteOggArtifactReader(
      artifactReader(Uint8Array.from([79, 103, 103, 83])),
      new ImmutableArtifactReadScope(),
    );

    await expect(reader.read("s3://meeting/recordings/speaker.ogg", {
      maxBytes: 64,
      signal: new AbortController().signal,
    })).rejects.toThrow("immutable artifact identity");
  });
});
