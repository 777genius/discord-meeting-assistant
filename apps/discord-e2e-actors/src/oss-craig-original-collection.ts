import { readdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { readRegular, requireEvidence as check, sha256 } from "./oss-campaign-artifacts.js";
import { digest, id, revision } from "./oss-campaign-profile.js";

export const requiredCraigSourceRoot =
  "/mnt/volume_ams3_1784742570542/vtoss-astra-y-20260905/readonly/craig-37b86a958b567cb7fcff75946e94fe5e7ee38f42";
const pinnedCraigRevision = "37b86a958b567cb7fcff75946e94fe5e7ee38f42";
const manifestSource = z.object({ recordingId: id,
  source: z.object({ kind: z.literal("craig-original-multitrack"), checksumSha256: digest }).strict(),
});

/** Reads the documented manifest source contract and recomputes each retained
 * original's size/SHA-256. Does NOT label the declared aggregate digest recomputed:
 * the external producer algorithm is absent from this checkout. */
export async function collectCraigOriginals(input: {
  originalDirectory: string; manifestBytes: Buffer; craigRevision: string;
}) {
  check(revision.parse(input.craigRevision) === pinnedCraigRevision, "Unpinned Craig original source");
  const manifest = manifestSource.parse(JSON.parse(input.manifestBytes.toString("utf8")));
  const root = resolve(input.originalDirectory);
  check(await realpath(root) === root, "Craig original root must not be a symlink");
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  let total = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    check(depth <= 4, "Craig original directory depth exceeded");
    const entries = await readdir(directory, { withFileTypes: true });
    check(entries.length <= 100 && files.length + entries.length <= 100, "Craig original file count exceeded");
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      check(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(entry.name) && !entry.isSymbolicLink(), "Unsafe Craig original entry");
      const path = resolve(directory, entry.name);
      check(path.startsWith(root + sep) && await realpath(path) === path, "Craig original path escaped");
      if (entry.isDirectory()) { await visit(path, depth + 1); continue; }
      check(entry.isFile(), "Craig original must be a regular file");
      const bytes = await readRegular(path, 512 * 1024 * 1024);
      total += bytes.length;
      check(total <= 1024 * 1024 * 1024, "Craig original byte bound exceeded");
      files.push({ path: path.slice(root.length + 1).split(sep).join("/"), size: bytes.length, sha256: sha256(bytes) });
    }
  };
  await visit(root, 0);
  check(files.length > 0, "No retained Craig originals");
  return { kind: "oss-native-craig-originals-v1" as const, recordingId: manifest.recordingId,
    craigRevision: input.craigRevision, manifestSha256: sha256(input.manifestBytes), files,
    declaredSourceFilesChecksumSha256: manifest.source.checksumSha256,
    aggregateRecomputation: { status: "source-unavailable" as const, requiredSourceRoot: requiredCraigSourceRoot,
      requiredRevision: pinnedCraigRevision, requiredCapability: "original-source checksum implementation used by authoritative_ready" },
  };
}
