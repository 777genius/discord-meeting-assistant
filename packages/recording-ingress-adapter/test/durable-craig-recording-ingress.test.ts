import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  validateOggOpus,
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

function ingress(
  root: string,
  writer: MemoryArtifactWriter,
  limits?: ConstructorParameters<typeof DurableCraigRecordingIngress>[0]["limits"],
  finalizationSource: ConstructorParameters<typeof DurableCraigRecordingIngress>[0]["finalizationSource"] = "live-packet-spool",
): DurableCraigRecordingIngress {
  return new DurableCraigRecordingIngress({
    artifactLocatorPrefix: "memory://recordings",
    finalizationSource,
    ...(limits === undefined ? {} : { limits }),
    spoolRoot: root,
    writer,
  });
}

describe("DurableCraigRecordingIngress", () => {
  it("finalizes only checksummed tracks derived from the authoritative Craig original", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer, undefined, "craig-original");
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestPacketBatch(
      packetBatch({
        relativeTimeMs: 0,
        rtpSequence: 1,
        rtpTimestamp: 960,
        speakerId: firstSpeakerId,
      }),
    );

    await expect(
      adapter.ingestLifecycleEvent(lifecycle("meeting.ended")),
    ).resolves.toMatchObject({ kind: "accepted" });

    const track = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);
    const metadata = parseAuthoritativeTrackUploadMetadata({
      schemaVersion: 1,
      uploadId: "recording-1:track:1",
      recordingId: "recording-1",
      guildId,
      channelId,
      speakerId: firstSpeakerId,
      trackNumber: 1,
      timelineOffsetMs: 0,
      checksumSha256: createHash("sha256").update(track).digest("hex"),
      sizeBytes: track.byteLength,
    });
    await expect(
      adapter.ingestAuthoritativeTrack(metadata, (async function* () {
        yield track;
      })()),
    ).resolves.toMatchObject({ replayed: false, speakerId: firstSpeakerId });

    const ready = parseCraigLifecycleEvent({
      channelId,
      eventId: "recording-1:authoritative-ready",
      guildId,
      occurredAt: "2026-08-01T10:05:01.000Z",
      recordingId: "recording-1",
      schemaVersion: 1,
      type: "recording.authoritative_ready",
      endedAt: "2026-08-01T10:04:59.000Z",
      sourceFilesChecksumSha256: "a".repeat(64),
      trackCount: 1,
    });
    const finalized = await adapter.ingestLifecycleEvent(ready);

    expect(finalized).toMatchObject({
      kind: "finalized",
      recording: {
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

  it("refuses authoritative-ready until every declared original track is durable", async () => {
    const root = await spoolRoot();
    const adapter = ingress(root, new MemoryArtifactWriter(), undefined, "craig-original");
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestLifecycleEvent(lifecycle("meeting.ended"));

    await expect(
      adapter.ingestLifecycleEvent(
        parseCraigLifecycleEvent({
          channelId,
          eventId: "recording-1:authoritative-ready",
          guildId,
          occurredAt: "2026-08-01T10:05:01.000Z",
          recordingId: "recording-1",
          schemaVersion: 1,
          type: "recording.authoritative_ready",
          endedAt: "2026-08-01T10:05:00.000Z",
          sourceFilesChecksumSha256: "a".repeat(64),
          trackCount: 1,
        }),
      ),
    ).rejects.toMatchObject({ failure: "invalid-state" });
  });

  it("finalizes sequential speaker tracks and a verified manifest", async () => {
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

    const result = await adapter.ingestLifecycleEvent(lifecycle("meeting.ended"));
    expect(result.kind).toBe("finalized");
    if (result.kind !== "finalized") {
      throw new Error("expected a finalized recording");
    }
    expect(result.recording.speakerAudio).toEqual([
      expect.objectContaining({ speakerId: firstSpeakerId, timelineOffsetMs: 0 }),
      expect.objectContaining({ speakerId: secondSpeakerId, timelineOffsetMs: 40 }),
    ]);
    for (const reference of result.recording.speakerAudio) {
      const bytes = writer.artifacts.get(reference.audioLocator);
      expect(bytes).toBeDefined();
      validateOggOpus(bytes ?? new Uint8Array());
    }
    const manifestBytes = writer.artifacts.get(result.recording.manifestLocator);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
      tracks: Array<{ speakerId: string; timelineOffsetMs: number }>;
    };
    expect(manifest.tracks).toMatchObject([
      { speakerId: firstSpeakerId, timelineOffsetMs: 0 },
      { speakerId: secondSpeakerId, timelineOffsetMs: 40 },
    ]);
  });

  it("preserves overlapping global speaker offsets", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestPacketBatch(
      packetBatch(
        {
          relativeTimeMs: 100,
          rtpSequence: 1,
          rtpTimestamp: 0,
          speakerId: firstSpeakerId,
        },
        {
          relativeTimeMs: 110,
          rtpSequence: 1,
          rtpTimestamp: 0,
          speakerId: secondSpeakerId,
        },
      ),
    );

    const result = await adapter.ingestLifecycleEvent(lifecycle("meeting.ended"));
    expect(result.kind === "finalized" ? result.recording.speakerAudio : []).toMatchObject([
      { speakerId: firstSpeakerId, timelineOffsetMs: 100 },
      { speakerId: secondSpeakerId, timelineOffsetMs: 110 },
    ]);
  });

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

    const recovered = ingress(root, writer);
    await expect(recovered.ingestPacketBatch(batch)).resolves.toMatchObject({
      acceptedPackets: 0,
      duplicatePackets: 1,
    });
    await expect(
      recovered.ingestLifecycleEvent(lifecycle("meeting.ended")),
    ).resolves.toMatchObject({ kind: "finalized" });
  });

  it("resumes finalization after an artifact writer failure", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    const ended = lifecycle("meeting.ended");
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestPacketBatch(
      packetBatch({
        relativeTimeMs: 0,
        rtpSequence: 1,
        rtpTimestamp: 100,
        speakerId: firstSpeakerId,
      }),
    );
    writer.failNextManifest = true;
    await expect(adapter.ingestLifecycleEvent(ended)).rejects.toThrow("synthetic manifest failure");

    const recovered = ingress(root, writer);
    await expect(recovered.ingestLifecycleEvent(ended)).resolves.toMatchObject({
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
    await adapter.ingestPacketBatch(
      packetBatch({
        relativeTimeMs: 0,
        rtpSequence: 1,
        rtpTimestamp: 100,
        speakerId: firstSpeakerId,
      }),
    );
    writer.returnMismatchedReceipt = true;

    await expect(
      adapter.ingestLifecycleEvent(lifecycle("meeting.ended")),
    ).rejects.toMatchObject({ failure: "artifact-write-mismatch" });
    expect(await readdir(join(root, "active-v1"))).toHaveLength(1);
    expect(await readdir(join(root, "completed-v1"))).toEqual([]);
  });

  it("persists finalization replay while cleaning only the active spool", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const adapter = ingress(root, writer);
    const ended = lifecycle("meeting.ended");
    await adapter.ingestLifecycleEvent(lifecycle("meeting.started"));
    await adapter.ingestPacketBatch(
      packetBatch({
        relativeTimeMs: 0,
        rtpSequence: 1,
        rtpTimestamp: 100,
        speakerId: firstSpeakerId,
      }),
    );
    const first = await adapter.ingestLifecycleEvent(ended);
    const writesAfterFirstFinalization = writer.requests.length;
    const replay = await ingress(root, writer).ingestLifecycleEvent(ended);
    const startedReplay = await ingress(root, writer).ingestLifecycleEvent(
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
    await expect(ingress(root, writer).ingestLifecycleEvent(aborted)).resolves.toMatchObject({
      kind: "aborted",
      replayed: true,
    });
    await expect(
      adapter.ingestPacketBatch(
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
      await expect(ingress(root, writer, { maxActiveRecordings: 1 }).ingestLifecycleEvent(aborted))
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
          finalizationSource: "live-packet-spool",
          spoolRoot: "relative/spool",
          writer,
        }),
    ).toThrow(expect.objectContaining({ failure: "path-policy" }));
    expect(
      () =>
        new DurableCraigRecordingIngress({
          artifactLocatorPrefix: "memory://recordings/../escape",
          finalizationSource: "live-packet-spool",
          spoolRoot: tmpdir(),
          writer,
        }),
    ).toThrow(expect.objectContaining({ failure: "path-policy" }));
  });
});
