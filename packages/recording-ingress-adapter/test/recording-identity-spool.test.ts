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
const lateHumanId = "55555555555555555";
const producerCapabilityId = "meeting.lifecycle.sealed-actor-roster.v1";
const producerRevision = "0123456789abcdef0123456789abcdef01234567";
const temporaryRoots: string[] = [];

class MemoryArtifactWriter implements RecordingBinaryArtifactWriter {
  public readonly directBodies: Uint8Array[] = [];
  public omitVersionId = false;

  public async write(request: RecordingBinaryArtifactWriteRequest) {
    if (request.body instanceof Uint8Array) {
      this.directBodies.push(Uint8Array.from(request.body));
    } else {
      for await (const chunk of request.body) {
        // Consume the authoritative upload in the fake.
        void chunk;
      }
    }
    return {
      checksumSha256: request.checksumSha256,
      locator: request.locator,
      sizeBytes: request.sizeBytes,
      ...(this.omitVersionId
        ? {}
        : { versionId: `version-${createHash("sha256").update(request.locator).digest("hex")}` }),
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

function trustedEvent(input: Record<string, unknown>): CraigLifecycleEvent {
  return parseCraigLifecycleEvent({
    actorObservationState: "consistent",
    actorSemanticsVersion: 1,
    channelId,
    guildId,
    occurredAt: "2026-08-01T10:00:00.000Z",
    producerCapabilityId,
    producerRevision,
    recordingId: "recording-v3",
    schemaVersion: 3,
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
  it("requires storage to prove an immutable object version", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    writer.omitVersionId = true;
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

    await expect(
      ingress.ingestAuthoritativeTrack(original.metadata, bytesOnce(original.body)),
    ).rejects.toMatchObject({ failure: "artifact-write-mismatch" });
  });

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

    const [activeToken] = await readdir(join(root, "active-v1"));
    const metadataPath = join(root, "active-v1", activeToken ?? "missing", "metadata.json");
    const currentMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    const { identityProvenance: _identityProvenance, ...oldConsumerSpool } = currentMetadata;
    const oldConsumerSpoolBytes = `${JSON.stringify({
      ...oldConsumerSpool,
      schemaVersion: 2,
    })}\n`;
    await writeFile(metadataPath, oldConsumerSpoolBytes);

    const recovered = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    expect(await readFile(metadataPath, "utf8")).toBe(oldConsumerSpoolBytes);
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
      identityProvenance: null,
      kind: "finalized",
      lifecycleGeneration: 2,
      recording: {
        authoritativeDurationMs: 299_000,
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
      recording: { authoritativeDurationMs: 299_000 },
      schemaVersion: 5,
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
});

describe("trusted recording identity spool", () => {
  it("retains trusted producer evidence and late actor observations through restart", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const first = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    await first.ingestLifecycleEvent(trustedEvent({
      actors: [{ actorId: humanId, kind: "human" }],
      eventId: "v3-started",
      rosterState: "unsealed",
      type: "meeting.started",
    }));
    await first.ingestLifecycleEvent(trustedEvent({
      actor: { actorId: lateHumanId, kind: "human" },
      eventId: "v3-late-human-joined",
      occurredAt: "2026-08-01T10:01:00.000Z",
      type: "participant.joined",
    }));
    const [activeToken] = await readdir(join(root, "active-v1"));
    const metadataPath = join(root, "active-v1", activeToken ?? "missing", "metadata.json");
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
      actors: [
        { actorId: humanId, kind: "human" },
        { actorId: lateHumanId, kind: "human" },
      ],
      events: [
        { eventId: "v3-started", type: "meeting.started" },
        { eventId: "v3-late-human-joined", type: "participant.joined" },
      ],
      identityProvenance: { producerCapabilityId, producerRevision },
    });
    await first.ingestLifecycleEvent(trustedEvent({
      eventId: "v3-ended",
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
    for (const [actorId, trackNumber] of [[humanId, 1], [lateHumanId, 2]] as const) {
      const original = trackFor("recording-v3", actorId, trackNumber);
      await recovered.ingestAuthoritativeTrack(original.metadata, bytesOnce(original.body));
    }
    const actors = [
      { actorId: humanId, kind: "human" as const },
      { actorId: lateHumanId, kind: "human" as const },
    ];
    const finalized = await recovered.ingestLifecycleEvent(trustedEvent({
      actors,
      endedAt: "2026-08-01T10:04:59.000Z",
      eventId: "v3-authoritative-ready",
      occurredAt: "2026-08-01T10:05:01.000Z",
      rosterState: "sealed",
      sourceFilesChecksumSha256: "c".repeat(64),
      trackCount: 2,
      type: "recording.authoritative_ready",
    }));

    expect(finalized).toMatchObject({
      actors,
      identityProvenance: {
        actorObservationState: "consistent",
        actorSemanticsVersion: 1,
        producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
        producerRevision,
        rosterState: "sealed",
      },
      kind: "finalized",
      lifecycleGeneration: 3,
    });
    const manifestBody = writer.directBodies.at(-1);
    if (manifestBody === undefined) {
      throw new Error("trusted authoritative manifest was not written");
    }
    expect(JSON.parse(new TextDecoder().decode(manifestBody))).toMatchObject({
      actors,
      identityProvenance: {
        actorObservationState: "consistent",
        producerCapabilityId,
        producerRevision,
        rosterState: "sealed",
      },
      schemaVersion: 3,
    });
    const [receiptName] = await readdir(join(root, "completed-v1"));
    expect(JSON.parse(
      await readFile(join(root, "completed-v1", receiptName ?? "missing"), "utf8"),
    )).toMatchObject({
      identityProvenance: { producerCapabilityId, producerRevision, rosterState: "sealed" },
      lifecycleSchemaVersion: 3,
      recording: { authoritativeDurationMs: 299_000 },
      schemaVersion: 5,
    });
    await recovered.close();
  });

  it("keeps recording valid while contradictory actor observations poison identity eligibility", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const ingress = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    await ingress.ingestLifecycleEvent(trustedEvent({
      actors: [{ actorId: humanId, kind: "human" }],
      eventId: "conflict-started",
      rosterState: "unsealed",
      type: "meeting.started",
    }));
    await ingress.ingestLifecycleEvent(trustedEvent({
      actor: { actorId: humanId, kind: "automation" },
      eventId: "conflicting-observation",
      type: "participant.joined",
    }));
    await ingress.ingestLifecycleEvent(trustedEvent({
      eventId: "conflict-ended",
      occurredAt: "2026-08-01T10:05:00.000Z",
      reason: null,
      type: "meeting.ended",
    }));
    const original = trackFor("recording-v3", humanId, 1);
    await ingress.ingestAuthoritativeTrack(original.metadata, bytesOnce(original.body));

    await expect(ingress.ingestLifecycleEvent(trustedEvent({
      actors: [{ actorId: humanId, kind: "human" }],
      endedAt: "2026-08-01T10:04:59.000Z",
      eventId: "conflict-ready",
      occurredAt: "2026-08-01T10:05:01.000Z",
      rosterState: "sealed",
      sourceFilesChecksumSha256: "d".repeat(64),
      trackCount: 1,
      type: "recording.authoritative_ready",
    }))).resolves.toMatchObject({
      actors: [{ actorId: humanId, kind: "human" }],
      identityProvenance: { actorObservationState: "conflicted" },
      kind: "finalized",
    });
    await ingress.close();
  });

  it("classifies a contradictory authoritative-ready kind without blocking finalization", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const ingress = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    await ingress.ingestLifecycleEvent(trustedEvent({
      actors: [{ actorId: humanId, kind: "human" }],
      eventId: "ready-conflict-started",
      rosterState: "unsealed",
      type: "meeting.started",
    }));
    await ingress.ingestLifecycleEvent(trustedEvent({
      eventId: "ready-conflict-ended",
      occurredAt: "2026-08-01T10:05:00.000Z",
      reason: null,
      type: "meeting.ended",
    }));
    const original = trackFor("recording-v3", humanId, 1);
    await ingress.ingestAuthoritativeTrack(original.metadata, bytesOnce(original.body));

    await expect(ingress.ingestLifecycleEvent(trustedEvent({
      actors: [{ actorId: humanId, kind: "automation" }],
      endedAt: "2026-08-01T10:04:59.000Z",
      eventId: "ready-kind-conflict",
      occurredAt: "2026-08-01T10:05:01.000Z",
      rosterState: "sealed",
      sourceFilesChecksumSha256: "d".repeat(64),
      trackCount: 1,
      type: "recording.authoritative_ready",
    }))).resolves.toMatchObject({
      actors: [{ actorId: humanId, kind: "human" }],
      identityProvenance: { actorObservationState: "conflicted" },
      kind: "finalized",
    });
    await ingress.close();
  });

  it.each([
    ["producer revision", { producerRevision: "f".repeat(40) }],
    ["producer capability", { producerCapabilityId: "meeting.lifecycle.future.v99" }],
    ["actor semantics", { actorSemanticsVersion: 2 }],
  ] as const)("preserves initial producer evidence and poisons conflicting %s", async (
    _case,
    producerOverride,
  ) => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const ingress = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    await ingress.ingestLifecycleEvent(trustedEvent({
      actors: [{ actorId: humanId, kind: "human" }],
      eventId: "revision-started",
      rosterState: "unsealed",
      type: "meeting.started",
    }));
    await ingress.ingestLifecycleEvent(trustedEvent({
      eventId: "revision-ended",
      occurredAt: "2026-08-01T10:05:00.000Z",
      ...producerOverride,
      reason: null,
      type: "meeting.ended",
    }));
    const original = trackFor("recording-v3", humanId, 1);
    await ingress.ingestAuthoritativeTrack(original.metadata, bytesOnce(original.body));

    await expect(ingress.ingestLifecycleEvent(trustedEvent({
      actors: [{ actorId: humanId, kind: "human" }],
      endedAt: "2026-08-01T10:04:59.000Z",
      eventId: "revision-ready",
      occurredAt: "2026-08-01T10:05:01.000Z",
      ...producerOverride,
      rosterState: "sealed",
      sourceFilesChecksumSha256: "e".repeat(64),
      trackCount: 1,
      type: "recording.authoritative_ready",
    }))).resolves.toMatchObject({
      identityProvenance: {
        actorSemanticsVersion: 1,
        producerCapabilityId,
        actorObservationState: "conflicted",
        producerRevision,
      },
      kind: "finalized",
    });
    await ingress.close();
  });
});

describe("trusted recording roster semantics", () => {
  it("finalizes an unknown capability for fail-closed downstream admission", async () => {
    const capabilityId = "meeting.lifecycle.future.v99";
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const ingress = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    await ingress.ingestLifecycleEvent(trustedEvent({
      actors: [{ actorId: humanId, kind: "human" }],
      eventId: "eligibility-started",
      producerCapabilityId: capabilityId,
      rosterState: "unsealed",
      type: "meeting.started",
    }));
    await ingress.ingestLifecycleEvent(trustedEvent({
      eventId: "eligibility-ended",
      occurredAt: "2026-08-01T10:05:00.000Z",
      producerCapabilityId: capabilityId,
      reason: null,
      type: "meeting.ended",
    }));
    const [activeToken] = await readdir(join(root, "active-v1"));
    const metadataPath = join(root, "active-v1", activeToken ?? "missing", "metadata.json");
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
      identityProvenance: {
        actorObservationState: "consistent",
        rosterState: "unsealed",
      },
    });
    const original = trackFor("recording-v3", humanId, 1);
    await ingress.ingestAuthoritativeTrack(original.metadata, bytesOnce(original.body));

    await expect(ingress.ingestLifecycleEvent(trustedEvent({
      actors: [{ actorId: humanId, kind: "human" }],
      endedAt: "2026-08-01T10:04:59.000Z",
      eventId: "eligibility-ready",
      occurredAt: "2026-08-01T10:05:01.000Z",
      producerCapabilityId: capabilityId,
      rosterState: "sealed",
      sourceFilesChecksumSha256: "f".repeat(64),
      trackCount: 1,
      type: "recording.authoritative_ready",
    }))).resolves.toMatchObject({
      identityProvenance: {
        producerCapabilityId: capabilityId,
        rosterState: "sealed",
      },
      kind: "finalized",
      lifecycleGeneration: 3,
    });
    await ingress.close();
  });
});

describe("legacy recording identity spool", () => {
  it("drains an already-populated v1 spool without promoting its lifecycle generation", async () => {
    const root = await spoolRoot();
    const writer = new MemoryArtifactWriter();
    const recordingId = "recording-v1-active-rollout";
    const lifecycle = (input: Record<string, unknown>) => parseCraigLifecycleEvent({
      channelId,
      guildId,
      occurredAt: "2026-08-01T10:00:00.000Z",
      recordingId,
      schemaVersion: 1,
      ...input,
    });
    const started = lifecycle({
      eventId: "legacy-rollout-started",
      participantIds: [humanId],
      type: "meeting.started",
    });
    const first = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    await first.ingestLifecycleEvent(started);
    await first.close();

    const [activeToken] = await readdir(join(root, "active-v1"));
    const metadataPath = join(root, "active-v1", activeToken ?? "missing", "metadata.json");
    const originalBytes = await readFile(metadataPath, "utf8");
    const recovered = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    await expect(recovered.ingestLifecycleEvent(started)).resolves.toMatchObject({
      replayed: true,
    });
    await expect(recovered.ingestLifecycleEvent(trustedEvent({
      eventId: "legacy-rollout-ended",
      occurredAt: "2026-08-01T10:05:00.000Z",
      reason: null,
      recordingId,
      type: "meeting.ended",
    }))).rejects.toMatchObject({ failure: "conflicting-duplicate" });
    expect(await readFile(metadataPath, "utf8")).toBe(originalBytes);

    await recovered.ingestLifecycleEvent(lifecycle({
      eventId: "legacy-rollout-ended",
      occurredAt: "2026-08-01T10:05:00.000Z",
      reason: null,
      type: "meeting.ended",
    }));
    const original = trackFor(recordingId, humanId, 1);
    await recovered.ingestAuthoritativeTrack(original.metadata, bytesOnce(original.body));
    await expect(recovered.ingestLifecycleEvent(lifecycle({
      endedAt: "2026-08-01T10:04:59.000Z",
      eventId: "legacy-rollout-authoritative-ready",
      occurredAt: "2026-08-01T10:05:01.000Z",
      sourceFilesChecksumSha256: "a".repeat(64),
      trackCount: 1,
      type: "recording.authoritative_ready",
    }))).resolves.toMatchObject({
      actors: null,
      identityProvenance: null,
      kind: "finalized",
      lifecycleGeneration: 1,
    });
    await recovered.close();
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
    const [currentTrack] = Array.isArray(current.authoritativeTracks)
      ? current.authoritativeTracks as Record<string, unknown>[]
      : [];
    if (currentTrack === undefined) {
      throw new Error("legacy completion receipt track is required");
    }
    const { artifactVersionId: _artifactVersionId, ...legacyTrack } = currentTrack;
    const {
      actors: _actors,
      identityProvenance: _identityProvenance,
      lifecycleSchemaVersion: _lifecycleSchemaVersion,
      ...preUpgradeReceipt
    } = current;
    const preUpgradeBytes = `${JSON.stringify({
      ...preUpgradeReceipt,
      authoritativeTracks: [legacyTrack],
      schemaVersion: 2,
    })}\n`;
    await writeFile(receiptPath, preUpgradeBytes);

    const recovered = new DurableCraigRecordingIngress({
      artifactLocatorPrefix: "memory://recordings",
      spoolRoot: root,
      writer,
    });
    await expect(recovered.ingestLifecycleEvent(ready)).resolves.toMatchObject({
      actors: null,
      identityProvenance: null,
      kind: "finalized",
      lifecycleGeneration: 1,
      replayed: true,
      source: { roomId: channelId, scopeId: guildId },
    });
    expect(await readFile(receiptPath, "utf8")).toBe(preUpgradeBytes);
    await expect(
      recovered.ingestAuthoritativeTrack(original.metadata, bytesOnce(original.body)),
    ).rejects.toMatchObject({ failure: "artifact-write-mismatch" });
    await recovered.close();
  });
});
