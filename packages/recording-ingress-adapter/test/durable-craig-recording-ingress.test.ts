import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseAuthoritativeTrackUploadMetadata,
  parseCraigLifecycleEvent,
  parseVoicePacketBatch,
  type CraigLifecycleEvent,
  type VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  DurableCraigRecordingIngress,
  RecordingIngressAbortedError,
  RecordingIngressError,
  type RecordingBinaryArtifactWriter,
  type RecordingBinaryArtifactWriteRequest,
} from "../src/index.js";

const guildId = "11111111111111111";
const channelId = "22222222222222222";
const firstSpeakerId = "33333333333333333";
const secondSpeakerId = "44444444444444444";
const opus20Ms = Uint8Array.from([0xf8, 0xff, 0xfe]);
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

interface PacketInput {
  readonly receivedAtMs?: number;
  readonly recordingId?: string;
  readonly relativeTimeMs: number;
  readonly rtpSequence: number;
  readonly rtpTimestamp: number;
  readonly speakerId: string;
}

function packetBatch(...inputs: readonly PacketInput[]): VoicePacketBatch {
  return parseVoicePacketBatch({
    packets: inputs.map((input) => ({
      channelId,
      guildId,
      opusBase64: Buffer.from(opus20Ms).toString("base64"),
      receivedAtMs: input.receivedAtMs ?? 1_000 + input.relativeTimeMs,
      recordingId: input.recordingId ?? "recording-1",
      relativeTimeMs: input.relativeTimeMs,
      rtpSequence: input.rtpSequence,
      rtpTimestamp: input.rtpTimestamp,
      schemaVersion: 1,
      speakerId: input.speakerId,
    })),
    schemaVersion: 1,
  });
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

describe("authoritative Craig recording finalization", () => {
  it("finalizes only checksummed tracks derived from the authoritative Craig original", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestPacketBatch(
      packetBatch({
        relativeTimeMs: 0,
        rtpSequence: 1,
        rtpTimestamp: 960,
        speakerId: firstSpeakerId,
      }),
    );

    await expect(adapter.ingestLifecycleEvent(lifecycle("meeting.ended"))).resolves.toEqual({
      kind: "accepted",
      recordingId: "recording-1",
      replayed: false,
    });
    expect(writer.requests).toEqual([]);
    expect(await readdir(join(root, "completed-v1"))).toEqual([]);

    const track = originalTrack();
    await expect(
      adapter.ingestAuthoritativeTrack(track.metadata, bytesOnce(track.body)),
    ).resolves.toMatchObject({ replayed: false, speakerId: firstSpeakerId });

    const ready = authoritativeReady();
    const finalized = await adapter.ingestLifecycleEvent(ready);

    expect(finalized).toMatchObject({
      kind: "finalized",
      recording: {
        authoritativeDurationMs: 299_000,
        recordingId: "recording-1",
        speakerAudio: [{ speakerId: firstSpeakerId, timelineOffsetMs: 0 }],
      },
    });
    const manifestRequest = writer.requests.find(
      ({ locator }) => locator.endsWith("/authoritative/manifest.json"),
    );
    expect(manifestRequest).toBeDefined();
    const manifest = JSON.parse(
      new TextDecoder().decode(await readBody(manifestRequest!.body)),
    ) as { endedAt: string; source: { kind: string }; startedAt: string; tracks: unknown[] };
    expect(manifest.endedAt).toBe("2026-08-01T10:04:59.000Z");
    expect(manifest.source.kind).toBe("craig-original-multitrack");
    expect(manifest.startedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(manifest.tracks).toHaveLength(1);
  });
});

describe("authoritative Craig recording durability", () => {
  it("keeps completed Craig tracks immutable and reuses only an exact upload retry", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    const track = originalTrack();
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestLifecycleEvent(lifecycle("meeting.ended"));
    const accepted = await adapter.ingestAuthoritativeTrack(track.metadata, bytesOnce(track.body));
    await adapter.ingestLifecycleEvent(authoritativeReady());

    const storedBytes = writer.artifacts.get(accepted.locator)?.slice();
    if (storedBytes === undefined) {
      throw new Error("authoritative track bytes were not persisted");
    }
    const writesBeforeReplay = writer.requests.length;
    await expect(
      adapter.ingestAuthoritativeTrack(track.metadata, bodyMustNotBeRead()),
    ).resolves.toEqual({ ...accepted, replayed: true });
    expect(writer.requests).toHaveLength(writesBeforeReplay);

    const conflicting = originalTrack({
      body: Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 9, 8, 7]),
    });
    await expect(
      adapter.ingestAuthoritativeTrack(conflicting.metadata, bodyMustNotBeRead()),
    ).rejects.toMatchObject({ failure: "conflicting-duplicate" });
    const newTrack = originalTrack({ speakerId: secondSpeakerId, trackNumber: 2 });
    await expect(
      adapter.ingestAuthoritativeTrack(newTrack.metadata, bodyMustNotBeRead()),
    ).rejects.toMatchObject({ failure: "invalid-state" });
    expect(writer.requests).toHaveLength(writesBeforeReplay);
    expect(writer.artifacts.get(accepted.locator)).toEqual(storedBytes);

    const [receiptName] = await readdir(join(root, "completed-v1"));
    if (receiptName === undefined) {
      throw new Error("completion receipt is required");
    }
    await expect(
      readFile(join(root, "completed-v1", receiptName), "utf8").then(
        (value) => JSON.parse(value) as unknown,
      ),
    ).resolves.toMatchObject({
      authoritativeTracks: [
        {
          audioLocator: accepted.locator,
          checksumSha256: track.metadata.checksumSha256,
          sizeBytes: track.metadata.sizeBytes,
          speakerId: track.metadata.speakerId,
          timelineOffsetMs: track.metadata.timelineOffsetMs,
          trackNumber: track.metadata.trackNumber,
          uploadId: track.metadata.uploadId,
        },
      ],
      recording: { authoritativeDurationMs: 299_000 },
      schemaVersion: 5,
    });

    await adapter.close();
    const recovered = ingress(root, writer);
    await expect(
      recovered.ingestLifecycleEvent(authoritativeReady()),
    ).resolves.toMatchObject({
      kind: "finalized",
      recording: { authoritativeDurationMs: 299_000 },
      replayed: true,
    });
    await recovered.close();
  });

  it("persists track intent before storage and recovers a commit-then-fail retry", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    const track = originalTrack();
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestLifecycleEvent(lifecycle("meeting.ended"));
    writer.failAfterNextTrackWrite = true;

    await expect(
      adapter.ingestAuthoritativeTrack(track.metadata, bytesOnce(track.body)),
    ).rejects.toThrow("synthetic committed track failure");
    const requestsAfterFailure = writer.requests.length;
    const conflicting = originalTrack({
      body: Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 9, 8, 7]),
    });
    await expect(
      adapter.ingestAuthoritativeTrack(conflicting.metadata, bodyMustNotBeRead()),
    ).rejects.toMatchObject({ failure: "conflicting-duplicate" });
    expect(writer.requests).toHaveLength(requestsAfterFailure);

    await adapter.close();
    const recovered = ingress(root, writer);
    await expect(
      recovered.ingestLifecycleEvent(authoritativeReady()),
    ).rejects.toMatchObject({ failure: "invalid-state" });
    await expect(
      recovered.ingestAuthoritativeTrack(track.metadata, bytesOnce(track.body)),
    ).resolves.toMatchObject({ replayed: true, speakerId: firstSpeakerId });
    await expect(
      recovered.ingestLifecycleEvent(authoritativeReady()),
    ).resolves.toMatchObject({ kind: "finalized" });
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
    await expect(
      adapter.ingestAuthoritativeTrack(track.metadata, bodyMustNotBeRead()),
    ).rejects.toMatchObject({ failure: "corrupt-spool" });
    await expect(
      adapter.ingestLifecycleEvent(lifecycle("meeting.started", "recording-2")),
    ).rejects.toMatchObject({ failure: "corrupt-spool" });
    expect(writer.requests).toHaveLength(writesBeforeReplay);
  });

  it("does not consume active capacity when a completed receipt survives the cleanup crash window", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer, { maxActiveRecordings: 1 });
    const track = originalTrack();
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestLifecycleEvent(lifecycle("meeting.ended"));
    await adapter.ingestAuthoritativeTrack(track.metadata, bytesOnce(track.body));
    await adapter.ingestLifecycleEvent(authoritativeReady());

    const [receiptName] = await readdir(join(root, "completed-v1"));
    if (receiptName === undefined) {
      throw new Error("completion receipt is required for crash-window simulation");
    }
    // Simulates a crash after the durable completion receipt was fsynced but
    // before best-effort active-spool removal completed.
    await mkdir(join(root, "active-v1", receiptName.slice(0, -".json".length)));

    await expect(
      adapter.ingestLifecycleEvent(lifecycle("meeting.started", "recording-2")),
    ).resolves.toEqual({ kind: "accepted", recordingId: "recording-2", replayed: false });
  });

  it("refuses authoritative-ready until every declared original track is durable", async () => {
    const root = await spoolRoot();
    const adapter = ingress(root, new MemoryArtifactWriter());
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestLifecycleEvent(lifecycle("meeting.ended"));

    await expect(
      adapter.ingestLifecycleEvent(
        authoritativeReady(),
      ),
    ).rejects.toMatchObject({ failure: "invalid-state" });
  });

  it("keeps the live packet tee derived until Craig sends authoritative-ready", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestPacketBatch(
      packetBatch(
        {
          relativeTimeMs: 0,
          rtpSequence: 1,
          rtpTimestamp: 0,
          speakerId: firstSpeakerId,
        },
        {
          relativeTimeMs: 20,
          rtpSequence: 2,
          rtpTimestamp: 960,
          speakerId: firstSpeakerId,
        },
        {
          relativeTimeMs: 40,
          rtpSequence: 1,
          rtpTimestamp: 0,
          speakerId: secondSpeakerId,
        },
      ),
    );

    const ended = lifecycle("meeting.ended");
    await expect(adapter.ingestLifecycleEvent(ended)).resolves.toEqual({
      kind: "accepted",
      recordingId: "recording-1",
      replayed: false,
    });
    await adapter.close();
    const recovered = ingress(root, writer);
    await expect(recovered.ingestLifecycleEvent(ended)).resolves.toEqual({
      kind: "accepted",
      recordingId: "recording-1",
      replayed: true,
    });
    expect(writer.requests).toEqual([]);
    expect(await readdir(join(root, "completed-v1"))).toEqual([]);
    await expect(
      recovered.ingestPacketBatch(
        packetBatch({
          relativeTimeMs: 60,
          rtpSequence: 3,
          rtpTimestamp: 2_880,
          speakerId: firstSpeakerId,
        }),
      ),
    ).rejects.toMatchObject({ failure: "invalid-state" });
  });
});

describe("packet journal durability", () => {
  it("deduplicates retries durably and rejects conflicting packet content", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    const batch = packetBatch({
      relativeTimeMs: 0,
      rtpSequence: 1,
      rtpTimestamp: 100,
      speakerId: firstSpeakerId,
    });
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await expect(adapter.ingestPacketBatch(batch)).resolves.toMatchObject({
      acceptedPackets: 1,
      duplicatePackets: 0,
    });
    await adapter.close();
    const recovered = ingress(root, writer);
    await expect(recovered.ingestPacketBatch(batch)).resolves.toMatchObject({
      acceptedPackets: 0,
      duplicatePackets: 1,
    });

    const conflicting = structuredClone(batch);
    conflicting.packets[0] = {
      ...conflicting.packets[0]!,
      opusBase64: Buffer.from([0xf8, 0xaa]).toString("base64"),
    };
    await expect(recovered.ingestPacketBatch(conflicting)).rejects.toMatchObject({
      failure: "conflicting-duplicate",
    } satisfies Partial<RecordingIngressError>);
  });

  it("fails fast for a concurrent spool owner and permits only a stop-first handoff", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const firstOwner = ingress(root, writer);
    const secondOwner = ingress(root, writer);
    const firstBatch = packetBatch({
      relativeTimeMs: 0,
      rtpSequence: 1,
      rtpTimestamp: 100,
      speakerId: firstSpeakerId,
    });
    await firstOwner.acquireExclusiveSpoolOwnership();
    await expect(secondOwner.acquireExclusiveSpoolOwnership()).rejects.toMatchObject({
      failure: "invalid-state",
    });
    await firstOwner.ingestLifecycleEvent(lifecycle("meeting.started"));
    await firstOwner.ingestPacketBatch(firstBatch);
    await firstOwner.close();

    const replacement = ingress(root, writer);
    await replacement.acquireExclusiveSpoolOwnership();
    await expect(replacement.ingestPacketBatch(firstBatch)).resolves.toMatchObject({
      acceptedPackets: 0,
      duplicatePackets: 1,
    });
  });

  it("repairs a crash-torn journal tail before replay", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    const batch = packetBatch({
      relativeTimeMs: 0,
      rtpSequence: 1,
      rtpTimestamp: 100,
      speakerId: firstSpeakerId,
    });
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestPacketBatch(batch);
    const recordingToken = createHash("sha256")
      .update("recording-v1")
      .update("\0")
      .update("recording-1")
      .digest("hex");
    const speakerToken = createHash("sha256")
      .update("speaker-v1")
      .update("\0")
      .update(firstSpeakerId)
      .digest("hex");
    await appendFile(
      join(root, "active-v1", recordingToken, "speakers", `${speakerToken}.packets`),
      Uint8Array.from([0x20, 0x00]),
    );

    await adapter.close();
    const recovered = ingress(root, writer);
    await expect(recovered.ingestPacketBatch(batch)).resolves.toMatchObject({
      acceptedPackets: 0,
      duplicatePackets: 1,
    });
    await expect(
      recovered.ingestLifecycleEvent(lifecycle("meeting.ended")),
    ).resolves.toMatchObject({ kind: "accepted" });
    expect(writer.requests).toEqual([]);
  });

  it("resumes finalization after an artifact writer failure", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    const ended = lifecycle("meeting.ended");
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestLifecycleEvent(ended);
    const track = originalTrack();
    await adapter.ingestAuthoritativeTrack(track.metadata, (async function* () {
      yield track.body;
    })());
    writer.failNextManifest = true;
    const ready = authoritativeReady();
    await expect(adapter.ingestLifecycleEvent(ready)).rejects.toThrow("synthetic manifest failure");

    await adapter.close();
    const recovered = ingress(root, writer);
    await expect(recovered.ingestLifecycleEvent(ready)).resolves.toMatchObject({
      kind: "finalized",
      replayed: true,
    });
    expect(writer.artifacts.size).toBe(2);
  });

  it("withholds the snapshot and active-spool cleanup on an unverified write receipt", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestLifecycleEvent(lifecycle("meeting.ended"));
    const track = originalTrack();
    await adapter.ingestAuthoritativeTrack(track.metadata, (async function* () {
      yield track.body;
    })());
    writer.returnMismatchedReceipt = true;

    await expect(
      adapter.ingestLifecycleEvent(authoritativeReady()),
    ).rejects.toMatchObject({ failure: "artifact-write-mismatch" });
    expect(await readdir(join(root, "active-v1"))).toHaveLength(1);
    expect(await readdir(join(root, "completed-v1"))).toEqual([]);
  });

  it("persists finalization replay while cleaning only the active spool", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    const ready = authoritativeReady();
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestLifecycleEvent(lifecycle("meeting.ended"));
    const track = originalTrack();
    await adapter.ingestAuthoritativeTrack(track.metadata, (async function* () {
      yield track.body;
    })());
    const first = await adapter.ingestLifecycleEvent(ready);
    const writesAfterFirstFinalization = writer.requests.length;
    await adapter.close();
    const recovered = ingress(root, writer);
    const replay = await recovered.ingestLifecycleEvent(ready);
    const startedReplay = await recovered.ingestLifecycleEvent(
      lifecycle("meeting.started"),
    );

    expect(replay).toEqual({ ...first, replayed: true });
    expect(startedReplay).toEqual({
      kind: "accepted",
      recordingId: "recording-1",
      replayed: true,
    });
    expect(writer.requests).toHaveLength(writesAfterFirstFinalization);
    expect(await readdir(join(root, "active-v1"))).toEqual([]);
    expect(await readdir(join(root, "completed-v1"))).toHaveLength(1);
  });
});

describe("recording ingress lifecycle safety", () => {
  it("durably aborts without publishing artifacts", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    const aborted = lifecycle("meeting.aborted");
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await expect(adapter.ingestLifecycleEvent(aborted)).resolves.toMatchObject({
      kind: "aborted",
      replayed: false,
    });
    await adapter.close();
    const recovered = ingress(root, writer);
    await expect(recovered.ingestLifecycleEvent(aborted)).resolves.toMatchObject({
      kind: "aborted",
      replayed: true,
    });
    await expect(
      recovered.ingestPacketBatch(
        packetBatch({
          relativeTimeMs: 0,
          rtpSequence: 1,
          rtpTimestamp: 0,
          speakerId: firstSpeakerId,
        }),
      ),
    ).rejects.toMatchObject({ failure: "invalid-state" });
    expect(writer.requests).toEqual([]);
    expect(await readdir(join(root, "active-v1"))).toEqual([]);
    const abortedReceipts = await readdir(join(root, "aborted-v1"));
    expect(abortedReceipts).toHaveLength(1);
    await expect(
      readFile(join(root, "aborted-v1", abortedReceipts[0] ?? "missing"), "utf8")
        .then((value) => JSON.parse(value) as unknown),
    ).resolves.toMatchObject({
      endedAt: aborted.occurredAt,
      events: [
        { eventId: "meeting.started-1", type: "meeting.started" },
        { eventId: aborted.eventId, type: "meeting.aborted" },
      ],
      recordingId: aborted.recordingId,
      status: "aborted",
    });
  });

  it("keeps repeated aborts replayable without consuming active capacity", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer, { maxActiveRecordings: 1 });

    const recordingIds = ["aborted-recording-1", "aborted-recording-2"] as const;
    for (const recordingId of recordingIds) {
      const started = lifecycle("meeting.started", recordingId);
      const aborted = lifecycle("meeting.aborted", recordingId);
      await expect(adapter.ingestLifecycleEvent(started)).resolves.toMatchObject({
        kind: "accepted",
        replayed: false,
      });
      await expect(adapter.ingestLifecycleEvent(aborted)).resolves.toMatchObject({
        kind: "aborted",
        replayed: false,
      });
      if (recordingId === recordingIds[0]) {
        const [receiptName] = await readdir(join(root, "aborted-v1"));
        if (receiptName === undefined) {
          throw new Error("aborted receipt is required for crash-window simulation");
        }
        await mkdir(join(root, "active-v1", receiptName.slice(0, -".json".length)));
      }
    }

    for (const recordingId of recordingIds) {
      const aborted = lifecycle("meeting.aborted", recordingId);
      await expect(adapter.ingestLifecycleEvent(aborted))
        .resolves.toEqual({ kind: "aborted", recordingId, replayed: true });
    }

    expect(await readdir(join(root, "active-v1"))).toEqual([]);
    expect(await readdir(join(root, "aborted-v1"))).toHaveLength(2);
    expect(writer.requests).toEqual([]);
  });

  it("enforces batch, speaker, packet and recording byte limits", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer, {
      maxBatchOpusBytes: 3,
      maxOpusBytesPerPacket: 3,
      maxPacketsPerBatch: 1,
      maxPacketsPerRecording: 1,
      maxPacketsPerSpeaker: 1,
      maxRecordingOpusBytes: 3,
      maxSpeakerOpusBytes: 3,
      maxSpeakersPerRecording: 1,
    });
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await expect(
      adapter.ingestPacketBatch(
        packetBatch(
          {
            relativeTimeMs: 0,
            rtpSequence: 1,
            rtpTimestamp: 0,
            speakerId: firstSpeakerId,
          },
          {
            relativeTimeMs: 20,
            rtpSequence: 2,
            rtpTimestamp: 960,
            speakerId: firstSpeakerId,
          },
        ),
      ),
    ).rejects.toMatchObject({ failure: "limit-exceeded" });
    await adapter.ingestPacketBatch(
      packetBatch({
        relativeTimeMs: 0,
        rtpSequence: 1,
        rtpTimestamp: 0,
        speakerId: firstSpeakerId,
      }),
    );
    await expect(
      adapter.ingestPacketBatch(
        packetBatch({
          relativeTimeMs: 20,
          rtpSequence: 2,
          rtpTimestamp: 960,
          speakerId: firstSpeakerId,
        }),
      ),
    ).rejects.toMatchObject({ failure: "limit-exceeded" });
    await expect(
      adapter.ingestPacketBatch(
        packetBatch({
          relativeTimeMs: 20,
          rtpSequence: 1,
          rtpTimestamp: 0,
          speakerId: secondSpeakerId,
        }),
      ),
    ).rejects.toMatchObject({ failure: "limit-exceeded" });
  });

  it("honors caller cancellation before touching durable state", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const controller = new AbortController();
    controller.abort();

    await expect(
      ingress(root, writer).ingestLifecycleEvent(lifecycle("meeting.started"), {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RecordingIngressAbortedError);
    await expect(readFile(join(root, "completed-v1", "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(writer.requests).toEqual([]);
  });

  it("rejects a relative spool root and traversal-capable locator prefix", () => {
    const writer = new MemoryArtifactWriter();
    expect(
      () =>
        new DurableCraigRecordingIngress({
          artifactLocatorPrefix: "memory://recordings",
          spoolRoot: "relative/spool",
          writer,
        }),
    ).toThrow(expect.objectContaining({ failure: "path-policy" }));
    expect(
      () =>
        new DurableCraigRecordingIngress({
          artifactLocatorPrefix: "memory://recordings/../escape",
          spoolRoot: tmpdir(),
          writer,
        }),
    ).toThrow(expect.objectContaining({ failure: "path-policy" }));
  });
});
