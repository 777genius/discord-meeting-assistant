import { lstat, readdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { readRegular, requireEvidence as check, sha256 } from "./oss-campaign-artifacts.js";
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
  originalDirectory: string; manifestBytes: Buffer; craigRevision: string; jobBytes: Buffer;
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
    const bytes = await readRegular(path, 512 * 1024 * 1024, true);
    total += bytes.length;
    check(total <= 1024 * 1024 * 1024, "Craig original byte bound exceeded");
    originals.push({ path: entry.name, bytes });
  }
  const job: unknown = JSON.parse(input.jobBytes.toString("utf8"));
  const verified = verifyCraigOriginalBytes({ ...input, job, files: originals });
  return {
    kind: "oss-native-craig-originals-v1" as const, recordingId: verified.recordingId,
    craigRevision: input.craigRevision, manifestSha256: sha256(input.manifestBytes),
    files: originals.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha256(bytes) })),
    declaredSourceFilesChecksumSha256: verified.checksumSha256,
    aggregateRecomputation: {
      status: "recomputed" as const, checksumSha256: verified.checksumSha256,
      jobBase64: input.jobBytes.toString("base64")
    },
  };
}
