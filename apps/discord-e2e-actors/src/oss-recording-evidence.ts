import { z } from "zod";
import { digest, id, revision, time, type OssRun } from "./oss-campaign-profile.js";
import { requireEvidence as check, same, type Archive } from "./oss-campaign-artifacts.js";

const actor = z.object({ actorId: id, kind: z.enum(["automation", "human", "unknown"]) }).strict();
const provenance = z.object({
  actorObservationState: z.literal("consistent"), actorSemanticsVersion: z.literal(1),
  producerCapabilityId: id, producerRevision: revision, rosterState: z.literal("sealed"),
}).strict();
const speakerAudio = z.object({
  artifactRevision: id, audioLocator: id, checksumSha256: digest, sizeBytes: time,
  speakerId: id, timelineOffsetMs: time,
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  actors: z.array(actor).optional(), identityProvenance: provenance.optional(),
  channelId: id, guildId: id, recordingId: id, startedAt: z.iso.datetime(), endedAt: z.iso.datetime(),
  source: z.object({ kind: z.literal("craig-original-multitrack"), checksumSha256: digest }).strict(),
  tracks: z.array(speakerAudio.omit({ audioLocator: true }).extend({ locator: id,
    trackNumber: z.number().int().positive() }).strict()).length(2),
}).strict();
const completionSchema = z.object({
  schemaVersion: z.literal(6), lifecycleSchemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  actors: z.array(actor).nullable(), identityProvenance: provenance.nullable(),
  channelId: id, guildId: id, recordingId: id, finalEventDigest: digest, finalEventId: id,
  events: z.array(z.object({ digest, eventId: id, occurredAt: z.iso.datetime(), type: id }).strict()).min(3),
  recording: z.object({ authoritativeDurationMs: time, manifestChecksumSha256: digest,
    manifestLocator: id, manifestRevision: id, manifestSizeBytes: time, recordingId: id,
    speakerAudio: z.array(speakerAudio).length(2) }).strict(),
  authoritativeTracks: z.array(z.object({ artifactVersionId: id, audioLocator: id,
    checksumSha256: digest, sizeBytes: time, speakerId: id, timelineOffsetMs: time,
    trackNumber: z.number().int().positive(), uploadId: id }).strict()).length(2),
}).strict();
const originalInventorySchema = z.object({
  recordingId: id, craigRevision: revision, sourceFilesChecksumSha256: digest,
  files: z.array(z.object({ path: id, sha256: digest, size: time }).strict()).min(1),
}).strict();

export function verifyOssRecording(archive: Archive, run: OssRun): void {
  const manifest = manifestSchema.parse(archive.json(run.manifestPath, "object-storage"));
  const completion = completionSchema.parse(archive.json(run.completionPath, "postgres"));
  const inventory = originalInventorySchema.parse(archive.json(run.originalInventoryPath, "craig"));
  check(manifest.recordingId === run.recordingId && completion.recordingId === run.recordingId &&
    completion.recording.recordingId === run.recordingId && inventory.recordingId === run.recordingId &&
    manifest.guildId === archive.plan.target.guildId && manifest.channelId === archive.plan.target.voiceChannelId &&
    completion.guildId === manifest.guildId && completion.channelId === manifest.channelId &&
    completion.lifecycleSchemaVersion === manifest.schemaVersion,
  "Native recording identity mismatch");
  check(Date.parse(manifest.startedAt) === run.startedAtMs && Date.parse(manifest.endedAt) === run.endedAtMs &&
    completion.recording.authoritativeDurationMs === run.endedAtMs - run.startedAtMs,
  "Native recording time mismatch");
  check(same(manifest.actors ?? null, completion.actors) &&
    same(manifest.identityProvenance ?? null, completion.identityProvenance) &&
    (manifest.schemaVersion !== 3 || manifest.identityProvenance?.producerRevision === archive.plan.target.craigRevision),
  "Native producer revision/roster mismatch");
  check(inventory.craigRevision === archive.plan.target.craigRevision &&
    inventory.sourceFilesChecksumSha256 === manifest.source.checksumSha256 &&
    same(inventory.files.map(({ path }) => path).sort(), [...run.originals].sort()),
  "Original source checksum/inventory mismatch");
  for (const file of inventory.files) {
    const retained = archive.artifact(file.path);
    check(file.sha256 === retained.sha256 && file.size === retained.size, "Original file checksum mismatch");
  }
  const retainedManifest = archive.artifact(run.manifestPath);
  check(completion.recording.manifestChecksumSha256 === retainedManifest.sha256 &&
    completion.recording.manifestSizeBytes === retainedManifest.size &&
    completion.recording.manifestLocator === retainedManifest.source.locator &&
    completion.recording.manifestRevision === retainedManifest.source.version, "Completion manifest mismatch");
  check(new Set(completion.events.map((event) => event.eventId)).size === completion.events.length,
    "Duplicate lifecycle event effect");
  for (const lifecycle of run.lifecycle) {
    const events = completion.events.filter((event) => event.type === lifecycle.type);
    check(events.length === 1 && Date.parse(events[0]!.occurredAt) === lifecycle.atMs,
      "Missing/duplicate native lifecycle event");
    if (lifecycle.type === "recording.authoritative_ready") check(events[0]!.eventId === completion.finalEventId &&
      events[0]!.digest === completion.finalEventDigest, "Completion final event mismatch");
  }
  check(!completion.events.some((event) => ["meeting.aborted", "meeting.connection_lost"].includes(event.type)),
    "Recording terminal failure");
  check(new Set(manifest.tracks.map((track) => track.trackNumber)).size === 2 &&
    new Set(completion.authoritativeTracks.map((track) => track.trackNumber)).size === 2 &&
    new Set(completion.authoritativeTracks.map((track) => track.uploadId)).size === 2,
  "Duplicate native track/upload identity");
  for (const track of run.tracks) {
    const retained = archive.artifact(track.path);
    const declared = manifest.tracks.filter((entry) => entry.speakerId === track.speakerId);
    const accepted = completion.recording.speakerAudio.filter((entry) => entry.speakerId === track.speakerId);
    const stored = completion.authoritativeTracks.filter((entry) => entry.speakerId === track.speakerId);
    check(declared.length === 1 && accepted.length === 1 && stored.length === 1, "Native track bijection missing");
    check(declared[0]!.trackNumber === stored[0]!.trackNumber, "Native track number mismatch");
    for (const entry of [declared[0]!, accepted[0]!, stored[0]!]) {
      const locator = "locator" in entry ? entry.locator : entry.audioLocator;
      const version = "artifactVersionId" in entry ? entry.artifactVersionId : entry.artifactRevision;
      check(locator === retained.source.locator && version === retained.source.version &&
        entry.checksumSha256 === retained.sha256 && entry.sizeBytes === retained.size &&
        entry.timelineOffsetMs === track.timelineOffsetMs, "Native immutable track mismatch");
    }
  }
}
