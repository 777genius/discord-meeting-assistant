import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { collectFiniteArtifactManifest } from "../src/finite-artifact-manifest.js";

describe("finite campaign artifact manifest", () => {
  it("content-addresses every nested artifact in stable path order", async () => {
    const root = await mkdtemp(join(tmpdir(), "finite-artifacts-"));
    await mkdir(join(root, "run-1"));
    await writeFile(join(root, "z.json"), "z");
    await writeFile(join(root, "run-1", "a.json"), "a");
    await expect(collectFiniteArtifactManifest(root)).resolves.toMatchObject([
      { byteLength: 1, path: "run-1/a.json", sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb" },
      { byteLength: 1, path: "z.json", sha256: "594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06" },
    ]);
  });

  it("fails closed on symlinks rather than following an inconclusive artifact tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "finite-artifacts-link-"));
    await writeFile(join(root, "artifact.json"), "safe");
    await symlink(join(root, "artifact.json"), join(root, "alias.json"));
    await expect(collectFiniteArtifactManifest(root)).rejects.toThrow("symbolic links");
  });
});
