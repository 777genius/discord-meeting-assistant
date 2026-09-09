import { mkdtemp, rm, writeFile, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collectCraigOriginals, verifyCraigOriginalBytes } from "../src/oss-craig-original-collection.js";
import { sha256 } from "../src/oss-campaign-artifacts.js";

function fixture() {
  const files = ["data", "header1", "header2", "users", "info", "log"].map(kind =>
    ({ path: `recording.ogg.${kind}`, bytes: Buffer.from(`synthetic-${kind}`) }));
  const sourceFiles = files.map(file => ({
    kind: file.path.split(".").at(-1)!, relativePath: file.path,
    checksumSha256: sha256(file.bytes), sizeBytes: file.bytes.length
  }));
  const checksumSha256 = sha256(JSON.stringify(sourceFiles));
  return {
    files, craigRevision: "7776b698f6bec26eff52cd383f4e5a7f3f429f42",
    manifestBytes: Buffer.from(JSON.stringify({ recordingId: "recording", source: { kind: "craig-original-multitrack", checksumSha256 } })),
    job: {
      recordingId: "recording", sourceFiles, lifecycleV3Snapshot: {
        sealedReady: {
          type: "recording.authoritative_ready", recordingId: "recording", sourceFilesChecksumSha256: checksumSha256
        }
      }
    }
  };
}
it("recomputes producer insertion-key order and normalizes job ordering (synthetic only)", () => {
  const f = fixture();
  const expected = "fb66be6310f7a6f9a6dbb63c81eacaea574e64902fe6636619ffe26ef5337017";
  f.job.sourceFiles.reverse(); f.files.reverse();
  expect(verifyCraigOriginalBytes(f).checksumSha256).toBe(expected);
});
it.each(["37b86a958b567cb7fcff75946e94fe5e7ee38f42", "a".repeat(40)])(
  "rejects stale or arbitrary prepared-job producer %s", craigRevision => {
    expect(() => verifyCraigOriginalBytes({ ...fixture(), craigRevision })).toThrow("Unpinned");
  });
for (const mutation of ["missing", "duplicate", "alias", "bytes", "size", "digest", "ready", "manifest", "identity", "unprepared", "revision"] as const) {
  it(`fails closed for ${mutation}`, () => {
    const f = fixture();
    switch (mutation) {
      case "missing": f.files.pop(); break;
      case "duplicate": f.job.sourceFiles[1] = f.job.sourceFiles[0]!; break;
      case "alias": f.job.sourceFiles[0]!.relativePath = "./recording.ogg.data"; break;
      case "bytes": f.files[0]!.bytes = Buffer.from("mutated"); break;
      case "size": f.job.sourceFiles[0]!.sizeBytes++; break;
      case "digest": f.job.sourceFiles[0]!.checksumSha256 = "f".repeat(64); break;
      case "ready": f.job.lifecycleV3Snapshot.sealedReady.sourceFilesChecksumSha256 = "f".repeat(64); break;
      case "manifest": f.manifestBytes = Buffer.from(f.manifestBytes.toString().replace(f.job.lifecycleV3Snapshot.sealedReady.sourceFilesChecksumSha256, "f".repeat(64))); break;
      case "identity": f.job.lifecycleV3Snapshot.sealedReady.recordingId = "other"; break;
      case "unprepared": Reflect.deleteProperty(f.job.sourceFiles[0]!, "checksumSha256"); break;
      case "revision": f.craigRevision = "a".repeat(40); break;
    }
    expect(() => verifyCraigOriginalBytes(f)).toThrow();
  });
}
it("collects originals and refuses mutated bytes or filesystem aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "oss-craig-originals-test-"));
  try {
    const f = fixture();
    for (const file of f.files) { await writeFile(join(root, file.path), file.bytes); }
    const input = { ...f, originalDirectory: root, jobBytes: Buffer.from(JSON.stringify(f.job)) };
    expect((await collectCraigOriginals(input)).aggregateRecomputation.status).toBe("recomputed");
    await writeFile(join(root, f.files[0]!.path), "changed");
    await expect(collectCraigOriginals(input)).rejects.toThrow("changed");
    await rm(join(root, f.files[0]!.path));
    await symlink(join(root, f.files[1]!.path), join(root, f.files[0]!.path));
    await expect(collectCraigOriginals(input)).rejects.toThrow("Unsafe");
    await rm(join(root, f.files[0]!.path));
    await link(join(root, f.files[1]!.path), join(root, f.files[0]!.path));
    await expect(collectCraigOriginals(input)).rejects.toThrow("hardlink");
  } finally { await rm(root, { recursive: true }); }
});
