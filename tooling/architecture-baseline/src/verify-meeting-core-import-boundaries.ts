import { readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseMeetingCoreImportPolicy,
  type MeetingCoreImportPolicy,
} from "./meeting-core-import-policy.js";
import { collectModuleReferences } from "./module-references.js";
import { collectProductionSourceFiles } from "./production-source-files.js";

interface PackageManifest {
  readonly name?: unknown;
  readonly exports?: unknown;
}

export interface MeetingCoreImportBoundaryOptions {
  readonly repositoryRoot: string;
  readonly policyPath?: string;
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function pathBelongsToRoot(filePath: string, root: string): boolean {
  return filePath === root || filePath.startsWith(`${root}/`);
}

async function verifyExportPolicy(
  repositoryRoot: string,
  policy: MeetingCoreImportPolicy,
): Promise<readonly string[]> {
  const diagnostics: string[] = [];
  const manifestPath = resolve(repositoryRoot, policy.packageManifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
  if (manifest.name !== policy.packageName) {
    diagnostics.push(
      `${policy.packageManifest}: expected package name ${policy.packageName}, received ${String(manifest.name)}.`,
    );
  }
  if (
    typeof manifest.exports !== "object" ||
    manifest.exports === null ||
    Array.isArray(manifest.exports)
  ) {
    return [...diagnostics, `${policy.packageManifest}: exports must be an object.`];
  }

  const exports = manifest.exports as Record<string, unknown>;
  const actualExportKeys = Object.keys(exports).toSorted();
  const expectedExportKeys = policy.featureSubpaths
    .map((subpath) => `./${subpath}`)
    .toSorted();
  if (JSON.stringify(actualExportKeys) !== JSON.stringify(expectedExportKeys)) {
    diagnostics.push(
      `${policy.packageManifest}: exported keys (${actualExportKeys.join(", ")}) do not match policy (${expectedExportKeys.join(", ")}).`,
    );
  }

  for (const subpath of policy.featureSubpaths) {
    const exportKey = `./${subpath}`;
    const expectedTarget = `./src/features/${subpath}/index.ts`;
    if (exports[exportKey] !== expectedTarget) {
      diagnostics.push(
        `${policy.packageManifest}: ${exportKey} must target ${expectedTarget}.`,
      );
    }
  }

  return diagnostics;
}

export async function verifyMeetingCoreImportBoundaries(
  options: MeetingCoreImportBoundaryOptions,
): Promise<readonly string[]> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const policyPath = resolve(
    repositoryRoot,
    options.policyPath ?? "architecture/meeting-core-consumer-subpaths.json",
  );
  const policy = parseMeetingCoreImportPolicy(
    JSON.parse(await readFile(policyPath, "utf8")),
  );
  const diagnostics = [...(await verifyExportPolicy(repositoryRoot, policy))];

  for (const root of [...policy.productionSearchRoots, ...policy.consumers.flatMap(({ roots }) => roots)]) {
    try {
      await stat(resolve(repositoryRoot, root));
    } catch {
      diagnostics.push(`${normalizePath(relative(repositoryRoot, policyPath))}: configured path ${root} does not exist.`);
    }
  }

  const files = await collectProductionSourceFiles(
    repositoryRoot,
    policy.productionSearchRoots,
  );
  const packagePrefix = `${policy.packageName}/`;
  const knownFeatures = new Set(policy.featureSubpaths);

  for (const filePath of files) {
    const sourceText = await readFile(resolve(repositoryRoot, filePath), "utf8");
    for (const reference of collectModuleReferences(sourceText, filePath)) {
      if (
        reference.specifier !== policy.packageName &&
        !reference.specifier.startsWith(packagePrefix)
      ) {
        continue;
      }

      const location = `${filePath}:${reference.line}:${reference.column}`;
      const consumer = policy.consumers.find(({ roots }) =>
        roots.some((root) => pathBelongsToRoot(filePath, root)),
      );
      if (consumer === undefined) {
        diagnostics.push(
          `${location}: ${reference.specifier} is used by an unclassified production consumer.`,
        );
        continue;
      }
      if (reference.specifier === policy.packageName) {
        diagnostics.push(
          `${location}: ${consumer.boundary} must not import the ${policy.packageName} package root.`,
        );
        continue;
      }

      const subpath = reference.specifier.slice(packagePrefix.length);
      if (!knownFeatures.has(subpath)) {
        diagnostics.push(
          `${location}: ${reference.specifier} is an unknown or deep Meeting Core subpath.`,
        );
        continue;
      }
      if (!consumer.allowFeatureSubpaths.includes(subpath)) {
        diagnostics.push(
          `${location}: ${consumer.boundary} may not import Meeting Core feature ${subpath}.`,
        );
      }
    }
  }

  return diagnostics;
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedFilePath === currentFilePath) {
  const repositoryRoot = resolve(dirname(currentFilePath), "../../..");
  const diagnostics = await verifyMeetingCoreImportBoundaries({ repositoryRoot });
  if (diagnostics.length > 0) {
    throw new Error(
      `Meeting Core import boundary verification failed:\n${diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n")}`,
    );
  }
  process.stdout.write("Meeting Core import boundary contract passed.\n");
}
