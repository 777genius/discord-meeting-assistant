/// <reference types="node" />

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const repositoryRoot = new URL("../", import.meta.url);
const outputPath = new URL("../.build/meeting-platform-build-provenance.json", import.meta.url);

/**
 * @param {readonly string[]} args
 * @returns {Promise<string>}
 */
function gitText(args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout) => {
      if (error !== null) {
        reject(error);
      } else if (typeof stdout !== "string") {
        reject(new TypeError("Git returned non-text output"));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * @param {readonly string[]} args
 * @returns {Promise<Buffer>}
 */
function gitBuffer(args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout) => {
      if (error !== null) {
        reject(error);
      } else if (!Buffer.isBuffer(stdout)) {
        reject(new TypeError("Git returned non-buffer output"));
      } else {
        resolve(stdout);
      }
    });
  });
}

const status = await gitText(["status", "--porcelain=v1", "--untracked-files=all"]);
if (status.length !== 0) {
  throw new Error("build provenance requires a clean Git checkout");
}
const releaseRevision = (await gitText(["rev-parse", "--verify", "HEAD"])).trim();
const sourceTree = (await gitText(["rev-parse", "--verify", "HEAD^{tree}"])).trim();
const treeListing = await gitBuffer(["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
if (!/^[0-9a-f]{40}$/u.test(releaseRevision) || !/^[0-9a-f]{40}$/u.test(sourceTree)) {
  throw new Error("build provenance requires exact Git commit and tree identities");
}
const sourceTreeSha256 = createHash("sha256").update(treeListing).digest("hex");
const provenance = {
  releaseRevision,
  schemaVersion: 1,
  sourceTree,
  sourceTreeSha256,
};
await mkdir(new URL("../.build/", import.meta.url), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(provenance)}\n`, {
  encoding: "utf8",
  mode: 0o444,
});
process.stdout.write(`${outputPath.pathname}\n`);
