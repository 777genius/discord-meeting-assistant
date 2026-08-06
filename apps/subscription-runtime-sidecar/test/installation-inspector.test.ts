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
    const installationRoot = root;
    const launcherPath = join(installationRoot, "launcher.mjs");
    const manifestPath = join(installationRoot, "package.json");
    const launcher = "#!/usr/bin/env node\n";
    const auditedModules = {
      "audited-codex-jsonl-bridge-output.mjs": "export const bridge = true;\n",
      "audited-codex-jsonl-capture-store.mjs": "export const store = true;\n",
      "audited-codex-jsonl-capture.mjs": "export const capture = true;\n",
      "audited-codex-jsonl-events.mjs": "export const events = true;\n",
      "audited-xhigh-policy.mjs": "export const policy = true;\n",
    } as const;
    await writeFile(launcherPath, launcher);
    await Promise.all(
      Object.entries(auditedModules).map(([name, contents]) =>
        writeFile(join(installationRoot, name), contents),
      ),
    );
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
      ...Object.entries(auditedModules).map(([name, contents]) => ({
        bytes: new TextEncoder().encode(contents),
        name,
      })),
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
      packageRootRealpath: await realpath(installationRoot),
      runtimePackageVersion: "0.1.0-main.27",
    });

    await writeFile(launcherPath, `${launcher}// changed\n`);
    await expect(inspector.inspect()).rejects.toThrow("digest");
    await writeFile(launcherPath, launcher);
    for (const [name, contents] of Object.entries(auditedModules)) {
      await writeFile(join(installationRoot, name), `${contents}// changed\n`);
      await expect(inspector.inspect()).rejects.toThrow("digest");
      await writeFile(join(installationRoot, name), contents);
    }
  });
});
