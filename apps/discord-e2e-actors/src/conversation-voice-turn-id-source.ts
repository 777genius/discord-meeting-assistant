import { randomUUID } from "node:crypto";
import { constants, link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

const maximumTurnIdBytes = 257;
const pollIntervalMilliseconds = 25;
const correlationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export async function assertConversationVoiceTurnIdFileIsNew(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }
  throw new Error("Conversation voice turn ID file must not exist before the observer starts");
}

export async function waitForNewConversationVoiceTurnIdFile(input: {
  readonly notBeforeEpochMilliseconds: number;
  readonly path: string;
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds: number;
}): Promise<string> {
  const deadlineEpochMilliseconds = Date.now() + input.timeoutMilliseconds;
  for (;;) {
    assertNotAborted(input.signal);
    try {
      const turnId = await readConversationVoiceTurnIdFile(
        {
          notBeforeEpochMilliseconds: input.notBeforeEpochMilliseconds,
          path: input.path,
        },
      );
      assertNotAborted(input.signal);
      return turnId;
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    const remainingMilliseconds = deadlineEpochMilliseconds - Date.now();
    if (remainingMilliseconds <= 0) {
      throw new Error("Conversation voice turn ID file was not created before timeout");
    }
    await delay(Math.min(pollIntervalMilliseconds, remainingMilliseconds), input.signal);
  }
}

export async function readConversationVoiceTurnIdFile(input: {
  readonly afterPathInspection?: () => Promise<void>;
  readonly notBeforeEpochMilliseconds: number;
  readonly path: string;
}): Promise<string> {
  const pathStats = await lstat(input.path);
  assertSafeTurnIdFile(pathStats, input.notBeforeEpochMilliseconds);
  await input.afterPathInspection?.();
  const handle = await open(
    input.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const beforeRead = await handle.stat();
    assertSafeTurnIdFile(beforeRead, input.notBeforeEpochMilliseconds);
    if (beforeRead.dev !== pathStats.dev || beforeRead.ino !== pathStats.ino) {
      throw new Error("Conversation voice turn ID file changed before it could be read");
    }
    const bytes = new Uint8Array(maximumTurnIdBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    const afterRead = await handle.stat();
    if (
      afterRead.dev !== beforeRead.dev ||
      afterRead.ino !== beforeRead.ino ||
      afterRead.size !== beforeRead.size ||
      afterRead.mtimeMs !== beforeRead.mtimeMs
    ) {
      throw new Error("Conversation voice turn ID file changed while it was being read");
    }
    if (bytesRead !== beforeRead.size) {
      throw new Error("Conversation voice turn ID file could not be read completely");
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    const turnId = decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
    if (!correlationIdPattern.test(turnId)) {
      throw new Error("Conversation voice turn ID file contains an invalid correlation ID");
    }
    return turnId;
  } finally {
    await handle.close();
  }
}

export async function publishNewConversationVoiceTurnIdFile(input: {
  readonly path: string;
  readonly turnId: string;
}): Promise<void> {
  const finalPath = normalize(input.path);
  if (!isAbsolute(finalPath) || finalPath === "/") {
    throw new Error("Conversation voice turn ID output must be an absolute file path");
  }
  if (!correlationIdPattern.test(input.turnId)) {
    throw new Error("Conversation voice turn ID output contains an invalid correlation ID");
  }
  const temporaryPath = join(
    dirname(finalPath),
    `.${basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let handleOpen = true;
  try {
    await handle.writeFile(input.turnId, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handleOpen = false;
    await link(temporaryPath, finalPath);
  } finally {
    if (handleOpen) {
      await handle.close();
    }
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissingFileError(error)) {
        throw error;
      }
    });
  }
}

function assertSafeTurnIdFile(
  stats: Awaited<ReturnType<typeof lstat>>,
  notBeforeEpochMilliseconds: number,
): void {
  if (!stats.isFile()) {
    throw new Error("Conversation voice turn ID source must be a regular file");
  }
  if (stats.size <= 0 || stats.size > maximumTurnIdBytes) {
    throw new Error("Conversation voice turn ID file has an invalid size");
  }
  if (stats.mtimeMs < notBeforeEpochMilliseconds) {
    throw new Error("Conversation voice turn ID file is stale");
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("Conversation voice turn ID file wait was cancelled");
  }
}

async function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error("Conversation voice turn ID file wait was cancelled"));
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
  });
}
