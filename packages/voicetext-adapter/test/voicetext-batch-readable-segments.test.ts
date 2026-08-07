import { describe, expect, it } from "vitest";

import type { CompleteOggArtifactReader } from "../src/ogg-artifact-reader.js";
import {
  VoicetextBatchFinalTranscriptionAdapter,
  type VoicetextBatchPollingScheduler,
} from "../src/voicetext-batch-final-transcription-adapter.js";
import type {
  VoicetextBatchClient,
  VoicetextBatchTaskResult,
  VoicetextBatchTranscriptionResult,
} from "../src/voicetext-batch-client.js";

const jobId = "00000000-0000-4000-8000-000000000001";
const reader: CompleteOggArtifactReader = {
  read: async () => ({ bytes: validOgg(), complete: true, container: "ogg" }),
};
const scheduler: VoicetextBatchPollingScheduler = {
  nowMs: () => 0,
  sleep: async () => {},
};

describe("Voicetext batch readable segment mapping", () => {
  it("maps stable segment IDs and raw evidence turn IDs", async () => {
    const adapter = adapterFor({
      durationSeconds: 1,
      readableSegments: [{
        endSeconds: 1,
        sourceUtteranceIndices: [0, 1],
        startSeconds: 0,
        transcript: "  Готовим релиз.  ",
      }],
      utterances: [
        { endSeconds: 0.5, startSeconds: 0, transcript: "готовим" },
        { endSeconds: 1, startSeconds: 0.5, transcript: "релиз" },
      ],
    });

    const result = await adapter.transcribe(requestFixture());

    expect(result).toMatchObject({
      ok: true,
      value: {
        readableSegments: [{
          endMs: 11_000,
          segmentId: "readable-segment:v2:7:job-key:1:1:1:1",
          sourceTurnIds: [
            "turn:v2:7:job-key:1:1:1:1",
            "turn:v2:7:job-key:1:1:1:2",
          ],
          speakerId: "discord-user-a",
          startMs: 10_000,
          text: "Готовим релиз.",
        }],
        turns: [{ turnId: "turn:v2:7:job-key:1:1:1:1" }, {
          turnId: "turn:v2:7:job-key:1:1:1:2",
        }],
      },
    });
  });

  it("discards the complete readable set when one segment is semantically invalid", async () => {
    const adapter = adapterFor({
      durationSeconds: 1,
      readableSegments: [
        { endSeconds: 0.5, sourceUtteranceIndices: [0], startSeconds: 0, transcript: "Готовим." },
        { endSeconds: 1, sourceUtteranceIndices: [1], startSeconds: 0.4, transcript: "Релиз." },
      ],
      utterances: [
        { endSeconds: 0.5, startSeconds: 0, transcript: "готовим" },
        { endSeconds: 1, startSeconds: 0.5, transcript: "релиз" },
      ],
    });

    const result = await adapter.transcribe(requestFixture());

    expect(result).toMatchObject({
      ok: true,
      value: {
        readableSegments: [],
        turns: [{ text: "готовим" }, { text: "релиз" }],
      },
    });
  });

  it("keeps sentence metadata aligned when an overlapping turn start is normalized", async () => {
    const adapter = adapterFor({
      durationSeconds: 1,
      readableSegments: [
        { endSeconds: 0.501, sourceUtteranceIndices: [0], startSeconds: 0, transcript: "Готовим." },
        { endSeconds: 1, sourceUtteranceIndices: [1], startSeconds: 0.5, transcript: "Релиз." },
      ],
      utterances: [
        { endSeconds: 0.501, startSeconds: 0, transcript: "готовим" },
        { endSeconds: 1, startSeconds: 0.5, transcript: "релиз" },
      ],
    });

    const result = await adapter.transcribe(requestFixture());

    expect(result).toMatchObject({
      ok: true,
      value: {
        readableSegments: [
          { endMs: 10_501, startMs: 10_000, text: "Готовим." },
          { endMs: 11_000, startMs: 10_501, text: "Релиз." },
        ],
        turns: [
          { endMs: 10_501, startMs: 10_000, text: "готовим" },
          { endMs: 11_000, startMs: 10_501, text: "релиз" },
        ],
      },
    });
  });
});

function adapterFor(result: VoicetextBatchTranscriptionResult) {
  const completed: VoicetextBatchTaskResult = { jobId, kind: "completed", result };
  const client: VoicetextBatchClient = {
    poll: async () => completed,
    submit: async () => completed,
  };
  return new VoicetextBatchFinalTranscriptionAdapter(client, reader, {}, scheduler);
}

function requestFixture() {
  return {
    idempotencyKey: "job-key",
    meetingId: "meeting-1",
    recording: {
      manifestLocator: "s3://recording/manifest.json",
      recordingId: "recording-1",
      speakerAudio: [{
        audioLocator: "s3://recording/speaker-a.ogg",
        speakerId: "discord-user-a",
        timelineOffsetMs: 10_000,
      }],
    },
  };
}

function validOgg(): Uint8Array {
  const bytes = new Uint8Array(27);
  bytes.set([79, 103, 103, 83]);
  return bytes;
}
