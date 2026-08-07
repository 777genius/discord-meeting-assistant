import { describe, expect, it, vi } from "vitest";

import {
  GetRecordingPlayback,
  RecordingPlaybackNotReadyError,
  RecordingPlaybackTrackNotFoundError,
  type RecordingPlaybackAudioReader,
  type RecordingPlaybackCatalog,
} from "../src/recording-playback/application/recording-playback.js";

const readyCatalog: RecordingPlaybackCatalog = {
  findByMeetingId: async () => ({
    status: "ready",
    tracks: [
      { audioLocator: "s3://meeting-artifacts/recordings/a.ogg", timelineOffsetMs: 250 },
      { audioLocator: "s3://meeting-artifacts/recordings/b.ogg", timelineOffsetMs: 900 },
    ],
  }),
};

function audioFixture(): {
  readonly describeTrack: ReturnType<typeof vi.fn<RecordingPlaybackAudioReader["describe"]>>;
  readonly reader: RecordingPlaybackAudioReader;
} {
  const describeTrack = vi.fn<RecordingPlaybackAudioReader["describe"]>(
    async () => ({ contentType: "audio/ogg", sizeBytes: 10 }),
  );
  return {
    describeTrack,
    reader: {
      describe: describeTrack,
      read: vi.fn(async () => ({
        body: (async function* () { yield Uint8Array.of(1, 2); })(),
        contentLength: 2,
        contentType: "audio/ogg",
        sizeBytes: 10,
      })),
    },
  };
}

describe("GetRecordingPlayback", () => {
  it("exposes only stable track indexes and timeline offsets", async () => {
    const playback = new GetRecordingPlayback(readyCatalog, audioFixture().reader);

    await expect(playback.manifest("meeting-1")).resolves.toEqual({
      status: "ready",
      tracks: [
        { index: 0, timelineOffsetMs: 250 },
        { index: 1, timelineOffsetMs: 900 },
      ],
    });
  });

  it("does not expose tracks before playback is ready", async () => {
    const catalog: RecordingPlaybackCatalog = {
      findByMeetingId: async () => ({ status: "processing", tracks: [] }),
    };
    const playback = new GetRecordingPlayback(catalog, audioFixture().reader);

    await expect(playback.manifest("meeting-1")).resolves.toEqual({
      status: "processing",
      tracks: [],
    });
    await expect(playback.readTrack({ meetingId: "meeting-1", trackIndex: 0 }))
      .rejects.toEqual(expect.objectContaining({
        name: RecordingPlaybackNotReadyError.name,
        status: "processing",
      }));
  });

  it("rejects unknown track indexes before reading storage", async () => {
    const audio = audioFixture();
    const playback = new GetRecordingPlayback(readyCatalog, audio.reader);

    await expect(playback.describeTrack({ meetingId: "meeting-1", trackIndex: 9 }))
      .rejects.toBeInstanceOf(RecordingPlaybackTrackNotFoundError);
    await expect(playback.describeTrack({ meetingId: "meeting-1", trackIndex: -1 }))
      .rejects.toBeInstanceOf(RecordingPlaybackTrackNotFoundError);
    await expect(playback.describeTrack({ meetingId: "meeting-1", trackIndex: 1.5 }))
      .rejects.toBeInstanceOf(RecordingPlaybackTrackNotFoundError);
    expect(audio.describeTrack).not.toHaveBeenCalled();
  });
});
