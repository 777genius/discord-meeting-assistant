import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

const ROOT_MODE = 0o700;
const BARRIER_MODE = 0o600;
const PERMISSION_MASK = 0o777;
const BARRIER_NAME = /^[a-z][a-z0-9-]{0,63}$/u;

async function assertDirectory(path: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`Campaign barrier root is not a real directory: ${path}`);
  }
  if ((status.mode & PERMISSION_MASK) !== ROOT_MODE) {
    throw new Error(`Campaign barrier root must have mode 0700: ${path}`);
  }
}

export async function createCampaignBarrierRoot(path: string): Promise<void> {
  await mkdir(path, { mode: ROOT_MODE });
  await assertDirectory(path);
}

export async function writeCreateOnlyBarrier(
  rootPath: string,
  name: string,
  contents: string,
): Promise<string> {
  if (!BARRIER_NAME.test(name)) {
    throw new Error(`Invalid campaign barrier name: ${name}`);
  }
  await assertDirectory(rootPath);
  const barrierPath = join(rootPath, name);
  const handle = await open(
    barrierPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    BARRIER_MODE,
  );
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  const status = await lstat(barrierPath);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`Campaign barrier is not a real file: ${barrierPath}`);
  }
  if ((status.mode & PERMISSION_MASK) !== BARRIER_MODE) {
    throw new Error(`Campaign barrier must have mode 0600: ${barrierPath}`);
  }
  return barrierPath;
}
