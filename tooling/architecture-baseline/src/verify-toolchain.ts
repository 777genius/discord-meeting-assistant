import { readFile } from "node:fs/promises";

interface RepositoryManifest {
  readonly packageManager?: unknown;
}

const expectedNodeVersion = "24.18.0";
const expectedPackageManager = "pnpm@11.18.0";

const repositoryManifestUrl = new URL("../../../package.json", import.meta.url);
const manifest = JSON.parse(
  await readFile(repositoryManifestUrl, "utf8"),
) as RepositoryManifest;

if (process.versions.node !== expectedNodeVersion) {
  throw new Error(
    `Expected Node ${expectedNodeVersion}, received ${process.versions.node}.`,
  );
}

if (manifest.packageManager !== expectedPackageManager) {
  throw new Error(
    `Expected packageManager ${expectedPackageManager}, received ${String(manifest.packageManager)}.`,
  );
}

process.stdout.write("Pinned toolchain contract passed.\n");
