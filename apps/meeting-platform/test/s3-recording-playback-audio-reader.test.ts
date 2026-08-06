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
  it("uses a conditional single-range request and streams its bytes", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return { ContentLength: 10, ContentType: "audio/ogg", ETag: '"etag-1"' };
      }
      if (command instanceof GetObjectCommand) {
        return {
          Body: (async function* () { yield Uint8Array.of(2, 3, 4, 5); })(),
          ContentLength: 4,
        };
      }
      throw new Error("unexpected command");
    });
    const reader = readerWith(send);

    const result = await reader.read({ locator, range: { end: 5, start: 2 } });

    expect(result).toMatchObject({
      contentLength: 4,
      contentType: "audio/ogg",
      range: { end: 5, start: 2 },
      sizeBytes: 10,
    });
    expect(await collect(result.body)).toEqual([2, 3, 4, 5]);
    const get = send.mock.calls[1]?.[0];
    expect(get).toBeInstanceOf(GetObjectCommand);
    expect((get as GetObjectCommand).input).toMatchObject({
      IfMatch: '"etag-1"',
      Range: "bytes=2-5",
    });
  });

  it("resolves suffix ranges and rejects positions after the object", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return { ContentLength: 10, ContentType: "application/ogg" };
      }
      return {
        Body: (async function* () { yield Uint8Array.of(8, 9); })(),
        ContentLength: 2,
      };
    });
    const reader = readerWith(send);

    await expect(reader.read({ locator, range: { start: 10 } }))
      .rejects.toEqual(expect.objectContaining({
        name: RecordingPlaybackRangeNotSatisfiableError.name,
        sizeBytes: 10,
      }));
    const suffix = await reader.read({ locator, range: { suffixLength: 2 } });
    expect(suffix.range).toEqual({ end: 9, start: 8 });
  });

  it("fails closed for non-audio or empty objects", async () => {
    const reader = readerWith(vi.fn(async () => ({
      ContentLength: 0,
      ContentType: "text/plain",
    })));

    await expect(reader.describe({ locator }))
      .rejects.toBeInstanceOf(RecordingPlaybackAudioUnavailableError);
  });
});
