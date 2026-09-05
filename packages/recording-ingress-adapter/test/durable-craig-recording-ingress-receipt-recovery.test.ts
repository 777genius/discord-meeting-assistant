import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseAuthoritativeTrackUploadMetadata,
  parseCraigLifecycleEvent,
  type CraigLifecycleEvent,
} from "@discord-meeting/craig-gateway-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  DurableCraigRecordingIngress,
  RecordingIngressAbortedError,
  type RecordingBinaryArtifactWriter,
  type RecordingBinaryArtifactWriteRequest,
} from "../src/index.js";

const guildId = "11111111111111111";
const channelId = "22222222222222222";
const firstSpeakerId = "33333333333333333";
const secondSpeakerId = "44444444444444444";
const temporaryRoots: string[] = [];

class MemoryArtifactWriter implements RecordingBinaryArtifactWriter {
  public readonly artifacts = new Map<string, Uint8Array>();
  public readonly requests: RecordingBinaryArtifactWriteRequest[] = [];
  public failNextManifest = false;
  public failAfterNextTrackWrite = false;
  public returnMismatchedReceipt = false;

  public async write(request: RecordingBinaryArtifactWriteRequest) {
    if (request.signal?.aborted === true) {
      throw new RecordingIngressAbortedError();
    }
    this.requests.push(request);
    if (this.failNextManifest && request.contentType === "application/json") {
      this.failNextManifest = false;
      throw new Error("synthetic manifest failure");
    }
    const body = await readBody(request.body);
    const actualChecksum = createHash("sha256").update(body).digest("hex");
    expect(actualChecksum).toBe(request.checksumSha256);
    expect(body.byteLength).toBe(request.sizeBytes);
    const existing = this.artifacts.get(request.locator);
    if (existing !== undefined) {
      expect(existing).toEqual(body);
    }
    this.artifacts.set(request.locator, body.slice());
    if (this.failAfterNextTrackWrite && request.contentType === "audio/ogg") {
      this.failAfterNextTrackWrite = false;
      throw new Error("synthetic committed track failure");
    }
    return {
      checksumSha256: request.checksumSha256,
      locator: request.locator,
      sizeBytes: request.sizeBytes + (this.returnMismatchedReceipt ? 1 : 0),
      versionId: `version-${createHash("sha256").update(request.locator).digest("hex")}`,
    };
  }
}

async function readBody(
  body: RecordingBinaryArtifactWriteRequest["body"],
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function* bytesOnce(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

function bodyMustNotBeRead(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => {
      throw new Error("completed upload replay must not read the request body");
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function spoolRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "recording-ingress-test-"));
  temporaryRoots.push(root);
  return root;
}

function lifecycle(
  type: "meeting.started" | "meeting.ended" | "meeting.aborted",
  recordingId = "recording-1",
  eventId = `${type}-1`,
): CraigLifecycleEvent {
  const common = {
    channelId,
    eventId,
    guildId,
    occurredAt:
      type === "meeting.started" ? "2026-08-01T10:00:00.000Z" : "2026-08-01T10:05:00.000Z",
    recordingId,
    schemaVersion: 1,
    type,
  } as const;
  return parseCraigLifecycleEvent(
    type === "meeting.started"
      ? { ...common, participantIds: [firstSpeakerId, secondSpeakerId] }
      : { ...common, reason: null },
  );
}

function originalTrack(
  {
    body = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]),
    recordingId = "recording-1",
    speakerId = firstSpeakerId,
    timelineOffsetMs = 0,
    trackNumber = 1,
  }: {
    readonly body?: Uint8Array;
    readonly recordingId?: string;
    readonly speakerId?: string;
    readonly timelineOffsetMs?: number;
    readonly trackNumber?: number;
  } = {},
) {
  return {
    body,
    metadata: parseAuthoritativeTrackUploadMetadata({
      schemaVersion: 1,
      uploadId: `${recordingId}:track:${trackNumber}`,
      recordingId,
      guildId,
      channelId,
      speakerId,
      trackNumber,
      timelineOffsetMs,
      checksumSha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.byteLength,
    }),
  };
}

function authoritativeReady(
  {
    recordingId = "recording-1",
    trackCount = 1,
  }: {
    readonly recordingId?: string;
    readonly trackCount?: number;
  } = {},
): CraigLifecycleEvent {
  return parseCraigLifecycleEvent({
    channelId,
    eventId: `${recordingId}:authoritative-ready`,
    guildId,
    occurredAt: "2026-08-01T10:05:01.000Z",
    recordingId,
    schemaVersion: 1,
    type: "recording.authoritative_ready",
    endedAt: "2026-08-01T10:04:59.000Z",
    sourceFilesChecksumSha256: "a".repeat(64),
    trackCount,
  });
}

function ingress(
  root: string,
  writer: MemoryArtifactWriter,
  limits?: ConstructorParameters<typeof DurableCraigRecordingIngress>[0]["limits"],
): DurableCraigRecordingIngress {
  return new DurableCraigRecordingIngress({
    artifactLocatorPrefix: "memory://recordings",
    ...(limits === undefined ? {} : { limits }),
    spoolRoot: root,
    writer,
  });
}

describe("authoritative Craig completion receipt recovery", () => {
  it("resolves schema-five snapshots only from retained immutable authoritative track receipts", async () => {
    const root = await spoolRoot();
    const adapter = ingress(root, new MemoryArtifactWriter());
    const track = originalTrack();
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestLifecycleEvent(lifecycle("meeting.ended"));
    await adapter.ingestAuthoritativeTrack(track.metadata, bytesOnce(track.body));
    const finalized = await adapter.ingestLifecycleEvent(authoritativeReady());
    if (finalized.kind !== "finalized") { throw new Error("expected finalized recording"); }
    const [receiptName] = await readdir(join(root, "completed-v1"));
    if (receiptName === undefined) { throw new Error("expected durable receipt"); }
    const receiptPath = join(root, "completed-v1", receiptName);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      schemaVersion: number;
      recording: Record<string, unknown>;
    };
    receipt.schemaVersion = 5;
    delete receipt.recording.manifestRevision;
    delete receipt.recording.manifestChecksumSha256;
    delete receipt.recording.manifestSizeBytes;
    receipt.recording.speakerAudio = finalized.recording.speakerAudio.map((reference) => ({
      audioLocator: reference.audioLocator, speakerId: reference.speakerId,
      timelineOffsetMs: reference.timelineOffsetMs,
    }));
    await writeFile(receiptPath, JSON.stringify(receipt));
    const before = await readFile(receiptPath, "utf8");
    await expect(adapter.completedRecording("recording-1")).resolves.toMatchObject({
      recordingId: "recording-1", speakerAudio: finalized.recording.speakerAudio,
    });
    await expect(adapter.completedRecording("recording-1")).resolves.toMatchObject({
      recordingId: "recording-1", speakerAudio: finalized.recording.speakerAudio,
    });
    expect(await readFile(receiptPath, "utf8")).toBe(before);
  });

  it("fails closed when a legacy completion receipt cannot prove track identity", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    const track = originalTrack();
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestLifecycleEvent(lifecycle("meeting.ended"));
    await adapter.ingestAuthoritativeTrack(track.metadata, bytesOnce(track.body));
    await adapter.ingestLifecycleEvent(authoritativeReady());

    const [receiptName] = await readdir(join(root, "completed-v1"));
    if (receiptName === undefined) {
      throw new Error("completion receipt is required");
    }
    const receiptPath = join(root, "completed-v1", receiptName);
    const completed = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    const { authoritativeTracks: _authoritativeTracks, ...legacyReceipt } = completed;
    await writeFile(receiptPath, `${JSON.stringify({ ...legacyReceipt, schemaVersion: 1 })}\n`);

    const writesBeforeReplay = writer.requests.length;
    await expect(adapter.completedRecording("recording-1"))
      .rejects.toMatchObject({ failure: "corrupt-spool" });
    await expect(
      adapter.ingestAuthoritativeTrack(track.metadata, bodyMustNotBeRead()),
    ).rejects.toMatchObject({ failure: "corrupt-spool" });
    await expect(
      adapter.ingestLifecycleEvent(lifecycle("meeting.started", "recording-2")),
    ).rejects.toMatchObject({ failure: "corrupt-spool" });
    expect(writer.requests).toHaveLength(writesBeforeReplay);
  });
});
