import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collectCraigOriginals, requiredCraigSourceRoot } from "../src/oss-craig-original-collection.js";
import { sha256 } from "../src/oss-campaign-artifacts.js";

it("recomputes retained original files without inventing the unavailable Craig aggregate algorithm", async () => {
  const root = await mkdtemp(join(tmpdir(), "oss-craig-originals-test-"));
  try {
    const bytes = Buffer.from("retained-original-fixture");
    await writeFile(join(root, "recording.ogg"), bytes);
    const input = { originalDirectory: root, craigRevision: "37b86a958b567cb7fcff75946e94fe5e7ee38f42",
      manifestBytes: Buffer.from(JSON.stringify({ recordingId: "recording", source: {
        kind: "craig-original-multitrack", checksumSha256: "f".repeat(64),
      } })) };
    const inventory = await collectCraigOriginals(input);
    expect(inventory.files).toEqual([{ path: "recording.ogg", size: bytes.length, sha256: sha256(bytes) }]);
    expect(inventory.declaredSourceFilesChecksumSha256).toBe("f".repeat(64));
    expect(inventory.aggregateRecomputation).toMatchObject({ status: "source-unavailable", requiredSourceRoot: requiredCraigSourceRoot });
    await writeFile(join(root, "recording.ogg"), Buffer.from("changed"));
    expect((await collectCraigOriginals(input)).files[0]!.sha256).not.toBe(inventory.files[0]!.sha256);
    await symlink(join(root, "recording.ogg"), join(root, "alias.ogg"));
    await expect(collectCraigOriginals(input)).rejects.toThrow("Unsafe");
  } finally { await rm(root, { recursive: true }); }
});
