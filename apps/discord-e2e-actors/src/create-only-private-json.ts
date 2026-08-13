import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function writeCreateOnlyPrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o700
    || typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error("Create-only JSON parent must be a real owned mode-0700 directory");
  }
  const temporaryPath = join(directory, `.${basename(path)}.partial-${randomUUID()}`);
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await link(temporaryPath, path);
    await syncDirectory(directory);
  } finally {
    await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true });
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
  } finally {
    await handle?.close();
  }
}
