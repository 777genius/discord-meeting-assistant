/// <reference types="node" />

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = new URL("../../", import.meta.url);
const outputPath = new URL(
  "../../.build/meeting-platform-build-provenance.json",
  import.meta.url,
);

function git(args, encoding) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: repositoryRoot,
      encoding,
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout) => {
      if (error !== null) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

export function assertExactRevision(configuredRevision, releaseRevision) {
  if (!/^[0-9a-f]{40}$/u.test(releaseRevision)) {
    throw new Error("build provenance requires an exact 40-character Git commit");
  }
  if (configuredRevision !== releaseRevision) {
    throw new Error(
      "MEETING_PLATFORM_SOURCE_REVISION must equal the clean checkout HEAD",
    );
  }
}

export function assertDistinctApplicationIds(publicationId, craigId) {
  if (!/^\d{17,20}$/u.test(publicationId) || !/^\d{17,20}$/u.test(craigId)) {
    throw new Error("deployment requires two official Discord application IDs");
  }
  if (publicationId === craigId) {
    throw new Error("Craig and publication Discord application IDs must differ");
  }
}

export async function deploymentIdentityFromEnvFile(environmentPath) {
  const environment = await readFile(environmentPath, "utf8");
  const value = (name, pattern) => {
    const matches = environment
      .split(/\r?\n/u)
      .map((line) => line.match(new RegExp(`^\\s*${name}\\s*=\\s*(${pattern})\\s*$`, "u")))
      .filter((match) => match !== null)
      .map((match) => match[1]);
    if (matches.length !== 1) {
      throw new Error(`env file must contain exactly one unquoted ${name}`);
    }
    return matches[0];
  };
  const identity = {
    craigApplicationId: value("DISCORD_CRAIG_APPLICATION_ID", "\\d{17,20}"),
    publicationApplicationId: value(
      "DISCORD_PUBLICATION_APPLICATION_ID",
      "\\d{17,20}",
    ),
    revision: value("MEETING_PLATFORM_SOURCE_REVISION", "[0-9a-f]{40}"),
  };
  assertDistinctApplicationIds(
    identity.publicationApplicationId,
    identity.craigApplicationId,
  );
  return identity;
}

export async function replaceReadOnlyFile(destination, contents) {
  const destinationPath = fileURLToPath(destination);
  const destinationDirectory = dirname(destinationPath);
  await mkdir(destinationDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(destinationDirectory, ".provenance-"));
  const temporaryPath = join(temporaryDirectory, "provenance.json");
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o444);
    await rename(temporaryPath, destinationPath);
  } finally {
    await handle?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--env-file") {
    throw new Error("usage: generate-build-provenance.mjs --env-file <deployment.env>");
  }
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], "utf8");
  if (typeof status !== "string" || status.length !== 0) {
    throw new Error("build provenance requires a clean Git checkout");
  }
  const releaseRevision = (await git(
    ["rev-parse", "--verify", "HEAD"],
    "utf8",
  )).trim();
  const deploymentIdentity = await deploymentIdentityFromEnvFile(
    resolvePath(process.argv[3]),
  );
  assertExactRevision(deploymentIdentity.revision, releaseRevision);

  const sourceTree = (await git(
    ["rev-parse", "--verify", "HEAD^{tree}"],
    "utf8",
  )).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceTree)) {
    throw new Error("build provenance requires an exact Git tree identity");
  }
  const treeListing = await git(
    ["ls-tree", "-r", "-z", "--full-tree", "HEAD"],
    "buffer",
  );
  if (!Buffer.isBuffer(treeListing)) {
    throw new TypeError("Git returned non-buffer tree output");
  }
  const provenance = {
    releaseRevision,
    schemaVersion: 1,
    sourceTree,
    sourceTreeSha256: createHash("sha256").update(treeListing).digest("hex"),
  };
  await replaceReadOnlyFile(outputPath, `${JSON.stringify(provenance)}\n`);
  process.stdout.write(`${outputPath.pathname}\n`);
}

const invokedPath = process.argv[1] === undefined ? "" : resolvePath(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
