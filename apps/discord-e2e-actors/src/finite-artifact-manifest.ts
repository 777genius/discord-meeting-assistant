import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export interface FiniteArtifactDigest {
  readonly byteLength: number;
  readonly path: string;
  readonly sha256: string;
}

const maximumArtifactCount = 512;
const maximumArtifactBytes = 128 * 1024 * 1024;
const maximumTotalBytes = 1024 * 1024 * 1024;

export async function collectFiniteArtifactManifest(rootPath: string): Promise<readonly FiniteArtifactDigest[]> {
  const root = resolve(rootPath);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Finite artifact root must be one real directory");
  }
  const paths: string[] = [];
  await visit(root, root, paths);
  if (paths.length === 0 || paths.length > maximumArtifactCount) {
    throw new Error("Finite artifact manifest has an invalid bounded file count");
  }
  const artifacts: FiniteArtifactDigest[] = [];
  let totalBytes = 0;
  for (const path of paths.toSorted()) {
    const artifact = await hashStableFile(root, path);
    totalBytes += artifact.byteLength;
    if (totalBytes > maximumTotalBytes) {
      throw new Error("Finite campaign artifacts exceed the aggregate byte bound");
    }
    artifacts.push(artifact);
  }
  return Object.freeze(artifacts.map((artifact) => Object.freeze(artifact)));
}

export async function verifyFiniteArtifactManifest(
  rootPath: string,
  expected: readonly FiniteArtifactDigest[],
): Promise<readonly FiniteArtifactDigest[]> {
  const root = resolve(rootPath);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Finite artifact verification root must be one real directory");
  }
  if (expected.length === 0 || expected.length > maximumArtifactCount ||
    new Set(expected.map(({ path }) => path)).size !== expected.length) {
    throw new Error("Finite artifact receipt manifest is invalid");
  }
  const observed: FiniteArtifactDigest[] = [];
  let totalBytes = 0;
  for (const retained of expected) {
    if (retained.path.startsWith("/") || retained.path.split("/").includes("..")) {
      throw new Error("Finite artifact receipt path escaped its exact root");
    }
    const artifact = await hashStableFile(root, resolve(root, retained.path));
    totalBytes += artifact.byteLength;
    if (totalBytes > maximumTotalBytes || artifact.byteLength !== retained.byteLength ||
      artifact.sha256 !== retained.sha256 || artifact.path !== retained.path) {
      throw new Error(`Finite campaign artifact no longer matches its pass receipt: ${retained.path}`);
    }
    observed.push(artifact);
  }
  return Object.freeze(observed.map((artifact) => Object.freeze(artifact)));
}

async function visit(root: string, directoryPath: string, paths: string[]): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directoryPath, entry.name);
    assertContained(root, path);
    if (entry.isSymbolicLink()) {
      throw new Error("Finite campaign artifacts must not contain symbolic links");
    }
    if (entry.isDirectory()) {
      await visit(root, path, paths);
    } else if (entry.isFile()) {
      paths.push(path);
      if (paths.length > maximumArtifactCount) {
        throw new Error("Finite campaign artifacts exceed the file-count bound");
      }
    } else {
      throw new Error("Finite campaign artifacts contain an unsupported filesystem entry");
    }
  }
}

async function hashStableFile(root: string, path: string): Promise<FiniteArtifactDigest> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumArtifactBytes) {
    throw new Error("Finite campaign artifact is not a bounded regular file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let bytesReadTotal = 0;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) { break; }
      bytesReadTotal += bytesRead;
      if (bytesReadTotal > maximumArtifactBytes) {
        throw new Error("Finite campaign artifact grew beyond its byte bound");
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || bytesReadTotal !== before.size) {
      throw new Error("Finite campaign artifact changed while it was content-addressed");
    }
  } finally {
    await handle.close();
  }
  const retainedPath = relative(root, path).split(sep).join("/");
  if (retainedPath.length === 0 || retainedPath.startsWith("../")) {
    throw new Error("Finite campaign artifact escaped its exact root");
  }
  return { byteLength: bytesReadTotal, path: retainedPath, sha256: hash.digest("hex") };
}

function assertContained(root: string, path: string): void {
  const relation = relative(root, path);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error("Finite campaign artifact path escaped its exact root");
  }
}
