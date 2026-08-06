import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { runtimePackageName, runtimePackageVersion } from "./constants.js";
import type {
  InstallationIdentity,
  InstallationInspectorPort,
} from "./types.js";

const manifestSchema = z
  .object({
    name: z.literal(runtimePackageName),
    version: z.literal(runtimePackageVersion),
  })
  .loose();

const auditedLauncherModuleNames = [
  "audited-codex-jsonl-capture.mjs",
  "audited-codex-jsonl-bridge-output.mjs",
  "audited-codex-jsonl-events.mjs",
  "audited-codex-jsonl-capture-store.mjs",
  "audited-xhigh-policy.mjs",
] as const;

export interface FileInstallationInspectorOptions {
  readonly expectedLauncherSha256: string;
  readonly launcherPath: string;
  readonly packageManifestPath: string;
}

export class FileInstallationInspector
  implements InstallationInspectorPort
{
  public constructor(
    private readonly options: FileInstallationInspectorOptions,
  ) {
    if (!/^[0-9a-f]{64}$/u.test(options.expectedLauncherSha256)) {
      throw new Error("Expected launcher SHA-256 must be lowercase hexadecimal");
    }
  }

  public async inspect(): Promise<InstallationIdentity> {
    const [executableRealpath, packageManifestRealpath] = await Promise.all([
      realpath(this.options.launcherPath),
      realpath(this.options.packageManifestPath),
    ]);
    const launcherDirectory = dirname(executableRealpath);
    const moduleRealpaths = await Promise.all(
      auditedLauncherModuleNames.map((name) => realpath(join(launcherDirectory, name))),
    );
    if (moduleRealpaths.some((path) => dirname(path) !== launcherDirectory)) {
      throw new Error("Subscription runtime launcher bundle escapes its admitted directory");
    }
    await access(executableRealpath, constants.X_OK);
    const [executableStat, manifestStat, launcherBytes, manifestBytes, ...modules] =
      await Promise.all([
        stat(executableRealpath),
        stat(packageManifestRealpath),
        readFile(executableRealpath),
        readFile(packageManifestRealpath, "utf8"),
        ...moduleRealpaths.map(async (path) => ({
          bytes: await readFile(path),
          stat: await stat(path),
        })),
      ]);
    if (
      !executableStat.isFile() ||
      !manifestStat.isFile() ||
      modules.some((module) => !module.stat.isFile())
    ) {
      throw new Error("Subscription runtime installation is not file-backed");
    }
    const launcherSha256 = createAuditedLauncherBundleSha256([
      { bytes: launcherBytes, name: "launcher.mjs" },
      ...modules.map((module, index) => ({
        bytes: module.bytes,
        name: auditedLauncherModuleNames[index] ?? "invalid-module",
      })),
    ]);
    if (launcherSha256 !== this.options.expectedLauncherSha256) {
      throw new Error("Subscription runtime launcher digest is not admitted");
    }

    const manifest = manifestSchema.safeParse(parseJson(manifestBytes));
    if (!manifest.success) {
      throw new Error("Subscription runtime package identity is not admitted");
    }
    return {
      executableRealpath,
      launcherSha256,
      packageManifestRealpath,
      packageRootRealpath: await realpath(dirname(packageManifestRealpath)),
      runtimePackageVersion: manifest.data.version,
    };
  }
}

export function createAuditedLauncherBundleSha256(
  files: readonly { readonly bytes: Uint8Array; readonly name: string }[],
): string {
  const digest = createHash("sha256");
  for (const file of files.toSorted((left, right) => left.name.localeCompare(right.name))) {
    digest.update(file.name).update("\0");
    digest.update(String(file.bytes.byteLength)).update("\0");
    digest.update(file.bytes);
  }
  return digest.digest("hex");
}

export function installationIdentitiesEqual(
  left: InstallationIdentity,
  right: InstallationIdentity,
): boolean {
  return (
    left.executableRealpath === right.executableRealpath &&
    left.launcherSha256 === right.launcherSha256 &&
    left.packageManifestRealpath === right.packageManifestRealpath &&
    left.packageRootRealpath === right.packageRootRealpath &&
    left.runtimePackageVersion === right.runtimePackageVersion
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Subscription runtime package manifest is malformed");
  }
}
