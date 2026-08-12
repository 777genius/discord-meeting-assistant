import { createHash, randomUUID } from "node:crypto";
import { constants, link, lstat, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  conversationAnswerObserverReadySchema,
  conversationAnswerPlaybackIntentSchema,
  serializeConversationAnswerPlaybackReadinessEnvelope,
  type ConversationAnswerPlaybackIntent,
} from "@discord-meeting/conversation-runtime-contracts";

const maximumReceiptBytes = 1_536;
const pollIntervalMilliseconds = 25;
export {
  type ConversationAnswerPlaybackIntent,
} from "@discord-meeting/conversation-runtime-contracts";

export async function waitForConversationAnswerPlaybackIntent(input: {
  readonly meetingId: string;
  readonly notBeforeEpochMilliseconds: number;
  readonly root: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds: number;
}): Promise<ConversationAnswerPlaybackIntent> {
  const deadline = Date.now() + input.timeoutMilliseconds;
  for (;;) {
    assertNotAborted(input.signal);
    const entries = await safeDirectoryEntries(input.root);
    for (const name of entries) {
      if (!/^[a-f\d]{64}\.intent\.json$/u.test(name)) {
        continue;
      }
      const path = join(input.root, name);
      try {
        const intent = await readIntent(path, input.notBeforeEpochMilliseconds);
        if (intent.runId !== input.runId || intent.meetingId !== input.meetingId) {
          throw new Error("Conversation answer playback intent has the wrong run or meeting");
        }
        if (name !== `${receiptStem(intent)}.intent.json`) {
          throw new Error("Conversation answer playback intent filename digest is invalid");
        }
        return intent;
      } catch (error: unknown) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Conversation answer playback intent was not created before timeout");
    }
    await abortableDelay(Math.min(pollIntervalMilliseconds, remaining), input.signal);
  }
}

export async function publishConversationAnswerObserverReady(input: {
  readonly intent: ConversationAnswerPlaybackIntent;
  readonly root: string;
}): Promise<void> {
  await assertSafeHandshakeRoot(input.root);
  const intent = conversationAnswerPlaybackIntentSchema.parse(input.intent);
  const ready = conversationAnswerObserverReadySchema.parse({
    ...intent,
    type: "observer-ready",
  });
  await publishCreateOnlyJson(
    join(input.root, `${receiptStem(intent)}.ready.json`),
    ready,
  );
}

export async function assertConversationAnswerHandshakeRootIsNew(root: string): Promise<void> {
  const entries = await safeDirectoryEntries(root);
  if (entries.some((name) => /^(?:[a-f\d]{64})\.(?:intent|ready)\.json$/u.test(name))) {
    throw new Error("Conversation answer handshake root contains stale receipts");
  }
}

async function readIntent(
  path: string,
  notBeforeEpochMilliseconds: number,
): Promise<ConversationAnswerPlaybackIntent> {
  const pathStats = await lstat(path);
  assertSafeReceiptFile(pathStats, notBeforeEpochMilliseconds);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const beforeRead = await handle.stat();
    assertSafeReceiptFile(beforeRead, notBeforeEpochMilliseconds);
    if (beforeRead.dev !== pathStats.dev || beforeRead.ino !== pathStats.ino) {
      throw new Error("Conversation answer playback intent changed before read");
    }
    const bytes = new Uint8Array(maximumReceiptBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    const afterRead = await handle.stat();
    if (
      afterRead.dev !== beforeRead.dev || afterRead.ino !== beforeRead.ino ||
      afterRead.size !== beforeRead.size || afterRead.mtimeMs !== beforeRead.mtimeMs ||
      bytesRead !== beforeRead.size
    ) {
      throw new Error("Conversation answer playback intent changed while reading");
    }
    const decoded = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, bytesRead));
    return conversationAnswerPlaybackIntentSchema.parse(JSON.parse(decoded) as unknown);
  } finally {
    await handle.close();
  }
}

async function publishCreateOnlyJson(path: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maximumReceiptBytes) {
    throw new Error("Conversation answer observer-ready receipt is too large");
  }
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let handleOpen = true;
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
    await handle.close();
    handleOpen = false;
    await link(temporaryPath, path);
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

function receiptStem(intent: ConversationAnswerPlaybackIntent): string {
  return createHash("sha256")
    .update(serializeConversationAnswerPlaybackReadinessEnvelope(intent))
    .digest("hex");
}

function assertSafeReceiptFile(
  stats: Awaited<ReturnType<typeof lstat>>,
  notBeforeEpochMilliseconds: number,
): void {
  if (!stats.isFile()) {
    throw new Error("Conversation answer playback intent must be a regular file");
  }
  if (stats.size <= 0 || stats.size > maximumReceiptBytes) {
    throw new Error("Conversation answer playback intent has an invalid size");
  }
  if (stats.mtimeMs < notBeforeEpochMilliseconds) {
    throw new Error("Conversation answer playback intent is stale");
  }
}

async function safeDirectoryEntries(root: string): Promise<readonly string[]> {
  try {
    await assertSafeHandshakeRoot(root);
    return await readdir(root);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

async function assertSafeHandshakeRoot(root: string): Promise<void> {
  const stats = await lstat(root);
  if (!stats.isDirectory()) {
    throw new Error("Conversation answer handshake root must be a real directory");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error("Conversation answer handshake root permissions are too broad");
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("Conversation answer playback intent wait was cancelled");
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new Error("Conversation answer playback intent wait was cancelled"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
