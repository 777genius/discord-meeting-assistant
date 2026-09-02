/// <reference types="node" />

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const buildRoot = join(repositoryRoot, ".build");
const provenancePath = join(buildRoot, "meeting-platform-build-provenance.json");

function execute(file, args, options = {}) {
  return new Promise((fulfill, reject) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout) => {
      if (error === null) fulfill(stdout);
      else reject(error);
    });
  });
}

export async function generateGitBuildContext(destination) {
  const destinationPath = resolve(destination);
  if (dirname(destinationPath) !== buildRoot) {
    throw new Error("Git build context destination must be a direct child of .build");
  }
  const status = await execute("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (status.length !== 0) throw new Error("Git build context requires a clean checkout");
  await mkdir(buildRoot, { recursive: true });
  const temporary = await mkdtemp(join(buildRoot, ".git-context-"));
  try {
    const archive = join(temporary, "source.tar");
    const extracted = join(temporary, "context");
    await mkdir(extracted);
    await execute("git", ["archive", "--format=tar", `--output=${archive}`, "HEAD"], {
      cwd: repositoryRoot,
    });
    await execute("tar", ["-xf", archive, "-C", extracted]);
    await mkdir(join(extracted, ".build"));
    await copyFile(provenancePath, join(extracted, ".build", "meeting-platform-build-provenance.json"));
    await rm(destinationPath, { recursive: true, force: true });
    await rename(extracted, destinationPath);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return destinationPath;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    throw new Error("usage: generate-git-build-context.mjs <.build/destination>");
  }
  process.stdout.write(`${await generateGitBuildContext(process.argv[2])}\n`);
}
