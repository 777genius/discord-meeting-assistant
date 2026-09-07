import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collectCraigOriginals, readCraigSource, verifyCraigManifestAuthority, verifyCraigManifestOriginalBytes } from "../src/oss-craig-original-collection.js";
import { sha256 } from "../src/oss-campaign-artifacts.js";
import { originalSchema } from "../src/oss-native-campaign-sources.js";

// Producer meetingIntegration.ts SHA-256:
// a62f880010cc14a76972309ba61b710eec96d49cb46f7cd8064bba029e989f2a.
// Literal vector independently computed with UTF-8 JSON serialization.
function fixture() {
  const craigRevision = "37b86a958b567cb7fcff75946e94fe5e7ee38f42";
  const files = ["data", "header1", "header2", "users", "info", "log"].map(kind => ({
    path: `recording.ogg.${kind}`, bytes: Buffer.from(kind === "log" ? "" : `Ж😀-${kind}`)
  }));
  const ordered = files.map(file => ({ kind: file.path.split(".").at(-1)!, relativePath: file.path,
    checksumSha256: sha256(file.bytes), sizeBytes: file.bytes.length }));
  const manifest = { schemaVersion: 3, recordingId: "recording",
    actors: [{ actorId: "speaker", kind: "human" }], identityProvenance: {
      actorObservationState: "consistent", actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1", producerRevision: craigRevision, rosterState: "sealed"
    }, source: { kind: "craig-original-multitrack", checksumSha256: sha256(JSON.stringify(ordered)) }
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const object = { locator: "manifest", revision: "immutable-v1", sizeBytes: manifestBytes.length, checksumSha256: sha256(manifestBytes) };
  const recording = { recordingId: "recording", manifestLocator: object.locator, manifestRevision: object.revision,
    manifestSizeBytes: object.sizeBytes, manifestChecksumSha256: object.checksumSha256 };
  const completion = { schemaVersion: 6, lifecycleSchemaVersion: 3, recordingId: "recording",
    actors: manifest.actors, identityProvenance: manifest.identityProvenance, recording: structuredClone(recording) };
  return { craigRevision, files, ordered, manifest, manifestBytes, object, completion,
    database: { snapshot: { recording: structuredClone(recording) } } };
}

it("pins UTF-8, empty sidecars and producer insertion/array order independently of input order", () => {
  const f = fixture();
  expect(sha256(JSON.stringify(f.ordered))).toBe("21fa45f5cc4f96398570855e9a54a751a3e4641406f749aa3eba776c8e55d172");
  f.files = f.files.toReversed();
  expect(verifyCraigManifestOriginalBytes(f).checksumSha256).toBe(f.manifest.source.checksumSha256);
  expect(sha256(JSON.stringify(f.ordered.toReversed()))).not.toBe(f.manifest.source.checksumSha256);
  expect(sha256(JSON.stringify(f.ordered.map(({ kind, relativePath, checksumSha256, sizeBytes }) =>
    ({ checksumSha256, kind, relativePath, sizeBytes }))))).not.toBe(f.manifest.source.checksumSha256);
});

it("collects v2 after immediate acknowledged job/journal deletion, without opening either", async () => {
  const root = await mkdtemp(join(tmpdir(), "original-deleted-job-"));
  try {
    const f = fixture();
    for (const file of f.files) { await writeFile(join(root, file.path), file.bytes); }
    for (const name of ["prepared-job.json", "lifecycle-journal.json"]) {
      await writeFile(join(root, name), "ephemeral"); await rm(join(root, name));
    }
    verifyCraigManifestAuthority(f.manifestBytes, f.completion, f.database, f.object);
    const proof = originalSchema.parse(await collectCraigOriginals({ ...f, originalDirectory: root }));
    expect(proof.kind).toBe("oss-native-craig-originals-v2");
    expect(proof.aggregateRecomputation).not.toHaveProperty("jobBase64");
    expect(proof.files.find(file => file.path.endsWith(".log"))?.size).toBe(0);
    await expect(readFile(join(root, "prepared-job.json"))).rejects.toThrow();
    expect(originalSchema.safeParse({ ...proof, kind: "oss-native-craig-originals-v1" }).success).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["missing", "extra", "duplicate", "alias", "bytes", "revision", "producer-revision", "legacy", "unsealed", "capability", "inconsistent", "roster"])(
  "rejects original/provenance mutation %s", mutation => {
    const f = fixture();
    if (mutation === "missing") { f.files.pop(); }
    if (mutation === "extra") { f.files.push({ path: "extra", bytes: Buffer.alloc(0) }); }
    if (mutation === "duplicate") { f.files[1] = f.files[0]!; }
    if (mutation === "alias") { f.files[0]!.path = "./" + f.files[0]!.path; }
    if (mutation === "bytes") { f.files[0]!.bytes = Buffer.from("changed"); }
    if (mutation === "revision") { f.craigRevision = "a".repeat(40); }
    if (mutation === "producer-revision") { f.manifest.identityProvenance.producerRevision = "a".repeat(40); }
    if (mutation === "legacy") { f.manifest.schemaVersion = 1; }
    if (mutation === "unsealed") { f.manifest.identityProvenance.rosterState = "open"; }
    if (mutation === "capability") { f.manifest.identityProvenance.producerCapabilityId = "future"; }
    if (mutation === "inconsistent") { f.manifest.identityProvenance.actorObservationState = "conflicting"; }
    if (mutation === "roster") { f.manifest.actors = []; }
    f.manifestBytes = Buffer.from(JSON.stringify(f.manifest));
    expect(() => verifyCraigManifestOriginalBytes(f)).toThrow();
  });

it.each(["manifest-bytes", "object-version", "object-size", "object-hash", "completion-version", "completion-recording", "db-locator", "db-hash", "db-recording", "roster"])(
  "rejects independently substituted authority %s", mutation => {
    const f = fixture();
    if (mutation === "manifest-bytes") { f.manifestBytes = Buffer.from(f.manifestBytes.toString() + " "); }
    if (mutation === "object-version") { f.object.revision = "other"; }
    if (mutation === "object-size") { f.object.sizeBytes++; }
    if (mutation === "object-hash") { f.object.checksumSha256 = "f".repeat(64); }
    if (mutation === "completion-version") { f.completion.recording.manifestRevision = "other"; }
    if (mutation === "completion-recording") { f.completion.recordingId = "other"; }
    if (mutation === "db-locator") { f.database.snapshot.recording.manifestLocator = "other"; }
    if (mutation === "db-hash") { f.database.snapshot.recording.manifestChecksumSha256 = "f".repeat(64); }
    if (mutation === "db-recording") { f.database.snapshot.recording.recordingId = "other"; }
    if (mutation === "roster") { f.completion.actors = [{ actorId: "other", kind: "human" }]; }
    expect(() => { verifyCraigManifestAuthority(f.manifestBytes, f.completion, f.database, f.object); }).toThrow();
  });

it.each(["hardlink", "symlink", "escape", "bound"])("checks runtime source %s before copying", async mutation => {
  const root = await mkdtemp(join(tmpdir(), "original-source-inode-"));
  try {
    await writeFile(join(root, "source"), "bytes");
    if (mutation === "hardlink") { await link(join(root, "source"), join(root, "alias")); }
    if (mutation === "symlink") { await symlink(join(root, "source"), join(root, "alias")); }
    const path = mutation === "escape" ? "../outside" : mutation === "bound" ? "source" : "alias";
    await expect(readCraigSource(root, path, mutation === "bound" ? 1 : 100)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
