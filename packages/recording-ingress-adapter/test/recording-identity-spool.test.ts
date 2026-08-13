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
  type RecordingBinaryArtifactWriter,
  type RecordingBinaryArtifactWriteRequest,
} from "../src/index.js";

const guildId = "11111111111111111";
const channelId = "22222222222222222";
const humanId = "33333333333333333";
const automationId = "44444444444444444";
const temporaryRoots: string[] = [];

class MemoryArtifactWriter implements RecordingBinaryArtifactWriter {
  public async write(request: RecordingBinaryArtifactWriteRequest) {
    if (!(request.body instanceof Uint8Array)) {
      for await (const chunk of request.body) {
        // Consume the authoritative upload in the fake.
        void chunk;
      }
    }
    return {
      checksumSha256: request.checksumSha256,
      locator: request.locator,
      sizeBytes: request.sizeBytes,
    };
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function spoolRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "recording-identity-spool-test-"));
  temporaryRoots.push(root);
  return root;
}

function event(input: Record<string, unknown>): CraigLifecycleEvent {
  return parseCraigLifecycleEvent({
    channelId,
    guildId,
    occurredAt: "2026-08-01T10:00:00.000Z",
    recordingId: "recording-v2",
    schemaVersion: 2,
    ...input,
  });
}

function track(actorId: string, trackNumber: number) {
  return trackFor("recording-v2", actorId, trackNumber);
}

function trackFor(recordingId: string, actorId: string, trackNumber: number) {
  const body = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, trackNumber]);
  return {
    body,
    metadata: parseAuthoritativeTrackUploadMetadata({
      channelId,
      checksumSha256: createHash("sha256").update(body).digest("hex"),
      guildId,
      recordingId,
      schemaVersion: 1,
      sizeBytes: body.byteLength,
      speakerId: actorId,
      timelineOffsetMs: 0,
      trackNumber,
      uploadId: `${recordingId}:track:${trackNumber}`,
    }),
  };
}

function bytesOnce(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield bytes;
  })();
}

describe("recording identity spool", () => {
  it("retains v2 source and actors through restart while keeping automation tracks", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const actors = [
      { actorId: humanId, kind: "human" as const },
      { actorId: automationId, kind: "automation" as const },
    ];
    const first = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    await first.ingestLifecycleEvent(event({
      actors: [actors[0]],
      eventId: "started",
      type: "meeting.started",
    }));
    await first.ingestLifecycleEvent(event({
      actor: actors[1],
      eventId: "automation-joined",
      type: "participant.joined",
    }));
    await first.ingestLifecycleEvent(event({
      eventId: "ended",
      occurredAt: "2026-08-01T10:05:00.000Z",
      reason: null,
      type: "meeting.ended",
    }));
    await first.close();

    const recovered = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    for (const [actorId, trackNumber] of [[humanId, 1], [automationId, 2]] as const) {
      const original = track(actorId, trackNumber);
      await recovered.ingestAuthoritativeTrack(original.metadata, bytesOnce(original.body));
    }
    const finalized = await recovered.ingestLifecycleEvent(event({
      actors,
      endedAt: "2026-08-01T10:04:59.000Z",
      eventId: "authoritative-ready",
      occurredAt: "2026-08-01T10:05:01.000Z",
      sourceFilesChecksumSha256: "b".repeat(64),
      trackCount: 2,
      type: "recording.authoritative_ready",
    }));

    expect(finalized).toMatchObject({
      actors,
      kind: "finalized",
      recording: {
        speakerAudio: [{ speakerId: humanId }, { speakerId: automationId }],
      },
      source: { roomId: channelId, scopeId: guildId },
    });
    const [receiptName] = await readdir(join(root, "completed-v1"));
    const receipt = JSON.parse(
      await readFile(join(root, "completed-v1", receiptName ?? "missing"), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      actors,
      lifecycleSchemaVersion: 2,
      schemaVersion: 3,
    });
  });

  it("rejects authoritative-ready when an actor kind changes", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const ingress = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    await ingress.ingestLifecycleEvent(event({
      actors: [{ actorId: humanId, kind: "human" }],
      eventId: "started",
      type: "meeting.started",
    }));
    await ingress.ingestLifecycleEvent(event({
      eventId: "ended",
      occurredAt: "2026-08-01T10:05:00.000Z",
      reason: null,
      type: "meeting.ended",
    }));
    const original = track(humanId, 1);
    await ingress.ingestAuthoritativeTrack(original.metadata, bytesOnce(original.body));

    await expect(ingress.ingestLifecycleEvent(event({
      actors: [{ actorId: humanId, kind: "automation" }],
      endedAt: "2026-08-01T10:04:59.000Z",
      eventId: "authoritative-ready",
      occurredAt: "2026-08-01T10:05:01.000Z",
      sourceFilesChecksumSha256: "b".repeat(64),
      trackCount: 1,
      type: "recording.authoritative_ready",
    }))).rejects.toMatchObject({ failure: "conflicting-duplicate" });
  });

  it("replays a pre-upgrade completed v1 receipt with legacy-null identity", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const recordingId = "recording-v1-before-identity";
    const lifecycle = (input: Record<string, unknown>) => parseCraigLifecycleEvent({
      channelId,
      guildId,
      occurredAt: "2026-08-01T10:00:00.000Z",
      recordingId,
      schemaVersion: 1,
      ...input,
    });
    const first = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    await first.ingestLifecycleEvent(lifecycle({
      eventId: "legacy-started",
      participantIds: [humanId],
      type: "meeting.started",
    }));
    await first.ingestLifecycleEvent(lifecycle({
      eventId: "legacy-ended",
      occurredAt: "2026-08-01T10:05:00.000Z",
      reason: null,
      type: "meeting.ended",
    }));
    const original = trackFor(recordingId, humanId, 1);
    await first.ingestAuthoritativeTrack(original.metadata, bytesOnce(original.body));
    const ready = lifecycle({
      endedAt: "2026-08-01T10:04:59.000Z",
      eventId: "legacy-authoritative-ready",
      occurredAt: "2026-08-01T10:05:01.000Z",
      sourceFilesChecksumSha256: "b".repeat(64),
      trackCount: 1,
      type: "recording.authoritative_ready",
    });
    await first.ingestLifecycleEvent(ready);
    await first.close();

    const [receiptName] = await readdir(join(root, "completed-v1"));
    const receiptPath = join(root, "completed-v1", receiptName ?? "missing");
    const current = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    const {
      actors: _actors,
      lifecycleSchemaVersion: _lifecycleSchemaVersion,
      ...preUpgradeReceipt
    } = current;
    await writeFile(receiptPath, `${JSON.stringify({
      ...preUpgradeReceipt,
      schemaVersion: 2,
    })}\n`);

    const recovered = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    await expect(recovered.ingestLifecycleEvent(ready)).resolves.toMatchObject({
      actors: null,
      kind: "finalized",
      replayed: true,
      source: { roomId: channelId, scopeId: guildId },
    });
    await recovered.close();
  });
});
