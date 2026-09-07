import { lstat, open, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { same, requireEvidence as check, sha256 } from "./oss-campaign-artifacts.js";
import { digest, id, revision } from "./oss-campaign-profile.js";

export const requiredCraigSourceRoot =
  "/mnt/volume_ams3_1784742570542/vtoss-astra-y-20260905/readonly/craig-37b86a958b567cb7fcff75946e94fe5e7ee38f42";
const pinnedCraigRevision = "37b86a958b567cb7fcff75946e94fe5e7ee38f42";
const recordingId = z.string().regex(/^[0-9A-Za-z_-]{1,128}$/u);
const manifestSource = z.object({
  recordingId,
  source: z.object({ kind: z.literal("craig-original-multitrack"), checksumSha256: digest }).strict(),
});

// Craig meetingIntegration.ts at the pinned revision, SHA-256
// a62f880010cc14a76972309ba61b710eec96d49cb46f7cd8064bba029e989f2a.
// create/parseOriginalRecordingJob requires all six files. Optional integrity
// metadata before preparation is mandatory after authoritativeReady; no file is optional.
const kinds = ["data", "header1", "header2", "users", "info", "log"] as const;
const jobSchema = z.object({
  recordingId,
  sourceFiles: z.array(z.object({
    kind: z.enum(kinds), relativePath: id,
    checksumSha256: digest, sizeBytes: z.number().int().nonnegative()
  })).length(6),
  lifecycleV3Snapshot: z.object({
    sealedReady: z.object({
      type: z.literal("recording.authoritative_ready"), recordingId: id,
      sourceFilesChecksumSha256: digest,
    }).loose()
  }),
});

export function verifyCraigOriginalBytes(input: {
  manifestBytes: Buffer; job: unknown;
  files: Array<{ path: string; bytes: Buffer }>; craigRevision: string
}) {
  check(revision.parse(input.craigRevision) === pinnedCraigRevision, "Unpinned Craig original source");
  const manifest = manifestSource.parse(JSON.parse(input.manifestBytes.toString("utf8")));
  const job = jobSchema.parse(input.job);
  check(job.recordingId === manifest.recordingId &&
    job.lifecycleV3Snapshot.sealedReady.recordingId === job.recordingId, "Craig job recording mismatch");
  check(input.files.length === 6 && new Set(input.files.map(file => file.path)).size === 6 &&
    new Set(job.sourceFiles.map(file => file.kind)).size === 6, "Craig source set missing or duplicate");
  const ordered = kinds.map(kind => {
    const source = job.sourceFiles.find(file => file.kind === kind)!;
    const relativePath = `${job.recordingId}.ogg.${kind}`;
    check(source.relativePath === relativePath, "Craig source path alias");
    const file = input.files.find(entry => entry.path === relativePath);
    check(file, "Craig original source missing");
    const checksumSha256 = sha256(file.bytes), sizeBytes = file.bytes.length;
    check(source.checksumSha256 === checksumSha256 && source.sizeBytes === sizeBytes, "Craig original changed after preparation");
    return { kind, relativePath, checksumSha256, sizeBytes };
  });
  // JSON.stringify insertion order is the producer contract, NOT sorted-key canonical JSON.
  const checksumSha256 = sha256(JSON.stringify(ordered));
  check(checksumSha256 === manifest.source.checksumSha256 &&
    checksumSha256 === job.lifecycleV3Snapshot.sealedReady.sourceFilesChecksumSha256,
    "Craig aggregate disagrees with manifest or authoritativeReady");
  return { checksumSha256, recordingId: job.recordingId };
}

export async function collectCraigOriginals(input: {
  originalDirectory: string; manifestBytes: Buffer; craigRevision: string; jobBytes?: Buffer;
}) {
  const root = resolve(input.originalDirectory);
  check(await realpath(root) === root, "Craig original root must not be a symlink");
  const entries = await readdir(root, { withFileTypes: true });
  check(entries.length === 6, "Craig source set missing or unexpected");
  const originals: Array<{ path: string; bytes: Buffer }> = [];
  let total = 0;
  for (const entry of entries) {
    check(entry.isFile() && !entry.isSymbolicLink(), "Unsafe Craig original entry");
    const path = resolve(root, entry.name);
    check(path.startsWith(root + sep) && await realpath(path) === path, "Craig original path escaped");
    check((await lstat(path)).nlink === 1, "Unsafe Craig original hardlink alias");
    const bytes = await readCraigSource(root, entry.name, 512 * 1024 * 1024, true);
    total += bytes.length;
    check(total <= 1024 * 1024 * 1024, "Craig original byte bound exceeded");
    originals.push({ path: entry.name, bytes });
  }
  const verified = input.jobBytes === undefined
    ? verifyCraigManifestOriginalBytes({ ...input, files: originals })
    : verifyCraigOriginalBytes({ ...input, job: JSON.parse(input.jobBytes.toString("utf8")), files: originals });
  return {
    kind: input.jobBytes === undefined ? "oss-native-craig-originals-v2" as const : "oss-native-craig-originals-v1" as const, recordingId: verified.recordingId,
    craigRevision: input.craigRevision, manifestSha256: sha256(input.manifestBytes),
    files: originals.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha256(bytes) })),
    declaredSourceFilesChecksumSha256: verified.checksumSha256,
    aggregateRecomputation: {
      status: "recomputed" as const, checksumSha256: verified.checksumSha256,
      ...(input.jobBytes === undefined ? {} : { jobBase64: input.jobBytes.toString("base64") })
    },
  };
}

/** New proof path: the durable ingress manifest is the source commitment. */
export function verifyCraigManifestOriginalBytes(input: {
  manifestBytes: Buffer; files: Array<{ path: string; bytes: Buffer }>; craigRevision: string;
}) {
  check(input.craigRevision === pinnedCraigRevision, "Unpinned Craig original source");
  const manifest = manifestSource.parse(JSON.parse(input.manifestBytes.toString("utf8")));
  const identity = sealedIdentity.parse(JSON.parse(input.manifestBytes.toString("utf8")));
  check(identity.identityProvenance.producerRevision === input.craigRevision,
    "Native producer revision mismatch");
  check(new Set(identity.actors.map(actor => actor.actorId)).size === identity.actors.length,
    "Duplicate sealed actor identity");
  check(input.files.length === 6 && new Set(input.files.map(file => file.path)).size === 6,
    "Craig source set missing or duplicate");
  const ordered = kinds.map(kind => {
    const relativePath = `${manifest.recordingId}.ogg.${kind}`;
    const file = input.files.find(entry => entry.path === relativePath);
    check(file, "Craig original source missing or aliased");
    return { kind, relativePath, checksumSha256: sha256(file.bytes), sizeBytes: file.bytes.length };
  });
  const checksumSha256 = sha256(JSON.stringify(ordered));
  check(checksumSha256 === manifest.source.checksumSha256, "Craig aggregate disagrees with manifest");
  return { checksumSha256, recordingId: manifest.recordingId };
}

const sealedIdentity = z.object({
  schemaVersion: z.literal(3),
  actors: z.array(z.object({ actorId: id, kind: z.enum(["human", "automation"]) }).strict()).min(1),
  identityProvenance: z.object({
    actorObservationState: z.literal("consistent"), actorSemanticsVersion: z.literal(1),
    producerCapabilityId: z.literal("meeting.lifecycle.sealed-actor-roster.v1"),
    producerRevision: z.literal(pinnedCraigRevision), rosterState: z.literal("sealed"),
  }).strict(),
});

export function verifyCraigManifestAuthority(manifestBytes: Buffer, completion: unknown, database: unknown,
  object: { locator: string; revision: string; sizeBytes: number; checksumSha256: string }) {
  const manifest = sealedIdentity.parse(JSON.parse(manifestBytes.toString("utf8")));
  const identity = z.object({ recordingId: id, manifestLocator: id, manifestRevision: id,
    manifestSizeBytes: z.number().int().positive(), manifestChecksumSha256: digest });
  const accepted = z.object({ schemaVersion: z.literal(6), lifecycleSchemaVersion: z.literal(3),
    actors: sealedIdentity.shape.actors, identityProvenance: sealedIdentity.shape.identityProvenance,
    recordingId: id, recording: identity }).parse(completion);
  const stored = z.object({ snapshot: z.object({ recording: identity }) }).parse(database).snapshot.recording;
  const source = manifestSource.parse(JSON.parse(manifestBytes.toString("utf8")));
  check(same(manifest.actors, accepted.actors) && same(manifest.identityProvenance, accepted.identityProvenance) &&
    accepted.recordingId === source.recordingId && accepted.recording.recordingId === source.recordingId &&
    same(accepted.recording, stored), "Native original authority/provenance mismatch");
  check(stored.manifestLocator === object.locator && stored.manifestRevision === object.revision &&
    stored.manifestSizeBytes === object.sizeBytes && object.sizeBytes === manifestBytes.length &&
    stored.manifestChecksumSha256 === object.checksumSha256 && object.checksumSha256 === sha256(manifestBytes),
    "Native original immutable manifest mismatch");
}

/** Inspect the opened runtime inode before copying; retention checks cannot detect source aliases. */
export async function readCraigSource(root: string, path: string, maxBytes: number, allowEmpty = false) {
  const full = resolve(root, path);
  check(full.startsWith(root + sep) && await realpath(full) === full, "Runtime source path escape/symlink");
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    check(before.isFile() && before.nlink === 1 && before.size <= maxBytes &&
      (allowEmpty || before.size > 0), "Unsafe runtime source type/hardlink/size");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      check(read.bytesRead > 0, "Runtime source truncated");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(full);
    check(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs &&
      after.nlink === 1 && named.ino === after.ino && named.dev === after.dev && await realpath(full) === full,
      "Runtime source changed while reading");
    return bytes;
  } finally { await handle.close(); }
}
