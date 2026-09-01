import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  CraigCampaignStackCommandRequest,
  CraigCampaignStackCommandResult,
  CraigCampaignStackPorts,
  CraigCredentialFileIdentityV1,
} from "./craig-disposable-campaign-stack.js";
import type { HostedCampaignReleaseReferenceV1 } from "./hosted-campaign-release-reference.js";

type CraigCredentialStorePort = CraigCampaignStackPorts["credentials"];
type CraigCommandExecutorPort = CraigCampaignStackPorts["commands"];

export class FileCraigCampaignCredentialStore implements CraigCredentialStorePort {
  async reserveCreateOnly(input: Readonly<{
    campaignId: string; contents: string; path: string; projectName: string;
    release: HostedCampaignReleaseReferenceV1;
  }>): Promise<CraigCredentialFileIdentityV1> {
    let handle: FileHandle | undefined;
    try {
      await assertUnsymlinkedParents(input.path);
      handle = await open(input.path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(input.contents, "utf8");
      await handle.sync();
      const status = await handle.stat();
      assertCredentialStatus(status);
      return Object.freeze({ device: status.dev, gid: status.gid, inode: status.ino, linkCount: 1,
        mode: "0600", sha256: createHash("sha256").update(input.contents).digest("hex"), uid: status.uid });
    } finally { await handle?.close(); }
  }
}

export class LocalDockerCommandExecutor implements CraigCommandExecutorPort {
  async execute(request: CraigCampaignStackCommandRequest): Promise<CraigCampaignStackCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, request.args, {
        cwd: request.workingDirectory, env: request.environment, shell: false,
        stdio: [request.standardInput === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      if (request.standardInput !== undefined) { child.stdin?.end(request.standardInput); }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); },
        request.timeoutMilliseconds);
      const append = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next) > 1024 * 1024) {
          child.kill("SIGKILL");
          throw new Error("Docker command output exceeded 1 MiB");
        }
        return next;
      };
      child.stdout?.on("data", (chunk: Buffer) => { try { stdout = append(stdout, chunk); } catch (error) { reject(error); } });
      child.stderr?.on("data", (chunk: Buffer) => { try { stderr = append(stderr, chunk); } catch (error) { reject(error); } });
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve({ exitCode: timedOut ? 124 : code ?? 1, stderr, stdout });
      });
    });
  }
}

export function trustedDockerEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({ HOME: "/var/empty", PATH: "/usr/bin:/bin" });
}

export async function assertUnsymlinkedParents(path: string): Promise<void> {
  const parts = dirname(path).split("/").filter(Boolean);
  let cursor = "/";
  for (const part of parts) {
    cursor = join(cursor, part);
    const status = await lstat(cursor);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("Craig credential path has an unsafe parent");
    }
  }
}

export async function writeCreateOnlyPrivateJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.partial-${randomUUID()}`);
  const handle = await open(temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await link(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true });
  }
}

function assertCredentialStatus(status: Stats): void {
  if (!status.isFile() || status.nlink !== 1 || (status.mode & 0o777) !== 0o600
    || (typeof process.getuid === "function" && status.uid !== process.getuid())) {
    throw new Error("Craig credential must be an owner-held single-link mode-0600 regular file");
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    await handle.sync();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") { throw error; }
  } finally { await handle?.close(); }
}
