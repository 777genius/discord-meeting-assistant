import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../", import.meta.url);
const outputPath = new URL("../.build/meeting-platform-build-provenance.json", import.meta.url);

async function git(args, encoding = "utf8") {
  const result = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding,
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout;
}

const status = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
if (status.length !== 0) {
  throw new Error("build provenance requires a clean Git checkout");
}
const releaseRevision = (await git(["rev-parse", "--verify", "HEAD"])).trim();
const sourceTree = (await git(["rev-parse", "--verify", "HEAD^{tree}"])).trim();
const treeListing = await git(
  ["ls-tree", "-r", "-z", "--full-tree", "HEAD"],
  "buffer",
);
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
