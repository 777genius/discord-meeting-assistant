import { createHash } from "node:crypto";
import { Meeting, type MeetingSnapshot } from "@discord-meeting/meeting-core/meeting-lifecycle";
import { ProcessMeetingSummary } from "@discord-meeting/meeting-core/post-call-workflow";
import type { FinalTranscriptionPort } from "@discord-meeting/meeting-core/transcription";
import type { BinaryArtifactReadResult } from "@discord-meeting/object-storage-adapter";
import { describe, expect, it, vi } from "vitest";
import { VerifiedRecordingRepository } from "../src/adapters/recording-compatibility/verified-recording-repository.js";
import { PostgresRecordingPlaybackCatalog } from "../src/recording-playback/adapters/postgres-recording-playback-catalog.js";
import { GetRecordingPlayback } from "../src/recording-playback/application/recording-playback.js";

const body = Buffer.from("synthetic authoritative audio");
const identity = {
  artifactRevision: "retained-version-1",
  checksumSha256: createHash("sha256").update(body).digest("hex"),
  sizeBytes: body.length,
};
const legacyRecording = {
  manifestLocator: "s3://private/recording-1/manifest.json", recordingId: "recording-1",
  speakerAudio: [{ audioLocator: "s3://private/recording-1/human.ogg", speakerId: "human", timelineOffsetMs: 120 }],
};
const completed = { ...legacyRecording, speakerAudio: [{ ...legacyRecording.speakerAudio[0]!, ...identity }] };

function fixture(current = false) {
  let row = Meeting.record({
    actors: [{ actorId: "human", kind: "human" }], identityProvenance: null,
    lifecycleGeneration: 2, meetingId: "meeting-1", publicationTargetId: "results",
    recording: current ? completed : legacyRecording,
    source: { roomId: "room-1", scopeId: "scope-1" },
  }).toSnapshot();
  const query = vi.fn(async () => ({ rows: [{ revision: row.revision, snapshot: structuredClone(row) }] }));
  const pool = { query } as unknown as ConstructorParameters<typeof VerifiedRecordingRepository>[0];
  const receipt = vi.fn<() => Promise<MeetingSnapshot["recording"] | undefined>>(async () => structuredClone(completed));
  const read = vi.fn(async (): Promise<BinaryArtifactReadResult> => ({
    body: (async function* () { yield body; })(),
    checksumSha256: identity.checksumSha256, contentType: "audio/ogg", metadata: {},
    sizeBytes: identity.sizeBytes, versionId: identity.artifactRevision,
  }));
  const onVerified = vi.fn();
  const repository = new VerifiedRecordingRepository(pool, { artifacts: { read }, completedRecording: receipt, onVerified });
  const save = vi.spyOn(repository, "save").mockImplementation(async (snapshot, expectedRevision) => {
    expect(expectedRevision).toBe(row.revision);
    row = structuredClone(snapshot);
  });
  const transcribe = vi.fn<FinalTranscriptionPort["transcribe"]>(async () => ({ ok: false as const,
    failure: { code: "SYNTHETIC_STOP_AFTER_ADMISSION", message: "test boundary", retryable: true } }));
  const process = new ProcessMeetingSummary({
    meetings: repository, transcriber: { transcribe },
    summarizer: { generate: vi.fn() }, publisher: { publish: vi.fn() },
  });
  const playback = new GetRecordingPlayback(new PostgresRecordingPlaybackCatalog(repository), {
    describe: async () => ({ contentType: "audio/ogg", sizeBytes: body.length }),
    read: vi.fn(),
  });
  return { onVerified, playback, process, query, read, receipt, repository, row: () => row, save, transcribe };
}

describe("verified legacy recording compatibility", () => {
  it.each([false, true])("uses exact immutable identities in playback and processing (current=%s)", async (current) => {
    const f = fixture(current);
    const before = structuredClone(f.row());
    await expect(f.playback.manifest("meeting-1")).resolves.toEqual({
      status: "ready", tracks: [{ index: 0, timelineOffsetMs: 120 }],
    });
    // Read compatibility itself is idempotent and does not mutate the stored row.
    await expect(f.repository.findById("meeting-1")).resolves.toMatchObject({ recording: completed });
    expect(f.row()).toEqual(before);
    expect(f.save).not.toHaveBeenCalled();
    await f.process.execute("meeting-1");
    expect(f.transcribe).toHaveBeenCalledOnce();
    expect(f.transcribe.mock.calls[0]?.[0]).toMatchObject({ recording: completed });
    expect(f.row().recording).toEqual(completed);
    if (current) {
      expect(f.receipt).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    } else {
      expect(f.read).toHaveBeenCalledWith({
        expected: { checksumSha256: identity.checksumSha256, sizeBytes: identity.sizeBytes },
        locator: completed.speakerAudio[0]!.audioLocator, revision: identity.artifactRevision,
      });
      expect(f.onVerified).toHaveBeenCalledWith({ meetingId: "meeting-1", recordingId: "recording-1" });
    }
  });

  it.each(["missing", "recording", "manifest", "speaker", "locator", "timeline", "unversioned", "duplicate"])("fails closed for %s completion evidence in both consumers", async (kind) => {
    const f = fixture();
    const receipt = structuredClone(completed);
    if (kind === "recording") { receipt.recordingId = "other"; }
    if (kind === "manifest") { receipt.manifestLocator = "s3://private/other"; }
    if (kind === "speaker") { receipt.speakerAudio[0]!.speakerId = "other"; }
    if (kind === "locator") { receipt.speakerAudio[0]!.audioLocator = "s3://private/other"; }
    if (kind === "timeline") { receipt.speakerAudio[0]!.timelineOffsetMs += 1; }
    if (kind === "duplicate") { receipt.speakerAudio.push(receipt.speakerAudio[0]!); }
    f.receipt.mockResolvedValue(kind === "missing" ? undefined : kind === "unversioned" ? legacyRecording : receipt);
    const before = structuredClone(f.row());
    await expect(f.playback.manifest("meeting-1")).rejects.toThrow("legacy recording");
    await expect(f.process.execute("meeting-1")).rejects.toThrow("legacy recording");
    expect(f.row()).toEqual(before); expect(f.save).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled(); expect(f.transcribe).not.toHaveBeenCalled();
  });

  it.each(["revision", "checksum", "size", "corrupt-body", "truncated-body", "stream-error"])("rejects %s before either consumer can use old data", async (kind) => {
    const f = fixture();
    const artifact = await f.read();
    f.read.mockResolvedValue({ ...artifact,
      ...(kind === "revision" ? { versionId: "wrong-version" } : {}),
      ...(kind === "checksum" ? { checksumSha256: "0".repeat(64) } : {}),
      ...(kind === "size" ? { sizeBytes: 1 } : {}),
      body: { async *[Symbol.asyncIterator]() {
        if (kind === "stream-error") { throw new Error("legacy recording stream error"); }
        yield kind === "corrupt-body" ? Buffer.alloc(body.length) : kind === "truncated-body" ? body.subarray(1) : body;
      } },
    });
    await expect(f.playback.manifest("meeting-1")).rejects.toThrow("legacy recording");
    await expect(f.process.execute("meeting-1")).rejects.toThrow("legacy recording");
    expect(f.save).not.toHaveBeenCalled(); expect(f.transcribe).not.toHaveBeenCalled();
    expect(f.onVerified).not.toHaveBeenCalled();
  });
});
