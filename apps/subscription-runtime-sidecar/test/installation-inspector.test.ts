import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAuditedLauncherBundleSha256,
  FileInstallationInspector,
} from "../src/installation-inspector.js";

describe("FileInstallationInspector", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { force: true, recursive: true });
    }
    root = undefined;
  });

  it("admits only the exact launcher bundle digest and package version", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-installation-test-"));
    const launcherPath = join(root, "launcher.mjs");
    const manifestPath = join(root, "package.json");
    const launcher = "#!/usr/bin/env node\n";
    const capture = "export const capture = true;\n";
    const policy = "export const policy = true;\n";
    await writeFile(launcherPath, launcher);
    await writeFile(join(root, "audited-codex-jsonl-capture.mjs"), capture);
    await writeFile(join(root, "audited-xhigh-policy.mjs"), policy);
    await chmod(launcherPath, 0o755);
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: "@vioxen/subscription-runtime",
        version: "0.1.0-main.27",
      }),
    );
    const expectedLauncherSha256 = createAuditedLauncherBundleSha256([
      { bytes: new TextEncoder().encode(launcher), name: "launcher.mjs" },
      { bytes: new TextEncoder().encode(capture), name: "audited-codex-jsonl-capture.mjs" },
      { bytes: new TextEncoder().encode(policy), name: "audited-xhigh-policy.mjs" },
    ]);
    const inspector = new FileInstallationInspector({
      expectedLauncherSha256,
      launcherPath,
      packageManifestPath: manifestPath,
    });

    await expect(inspector.inspect()).resolves.toEqual({
      executableRealpath: await realpath(launcherPath),
      launcherSha256: expectedLauncherSha256,
      packageManifestRealpath: await realpath(manifestPath),
      packageRootRealpath: await realpath(root),
      runtimePackageVersion: "0.1.0-main.27",
    });

    await writeFile(launcherPath, `${launcher}// changed\n`);
    await expect(inspector.inspect()).rejects.toThrow("digest");
    await writeFile(launcherPath, launcher);
    await writeFile(join(root, "audited-codex-jsonl-capture.mjs"), `${capture}// changed\n`);
    await expect(inspector.inspect()).rejects.toThrow("digest");
    await writeFile(join(root, "audited-codex-jsonl-capture.mjs"), capture);
    await writeFile(join(root, "audited-xhigh-policy.mjs"), `${policy}// changed\n`);
    await expect(inspector.inspect()).rejects.toThrow("digest");
  });
});
