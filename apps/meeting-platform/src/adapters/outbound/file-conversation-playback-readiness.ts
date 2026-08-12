import { createHash, randomUUID } from "node:crypto";
import { constants, link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  conversationAnswerObserverReadySchema,
  conversationAnswerPlaybackIntentSchema,
  conversationAnswerPlaybackReadinessEnvelopeSchema,
  conversationPlaybackReadinessProtocolVersion,
  serializeConversationAnswerPlaybackReadinessEnvelope,
  type ConversationAnswerPlaybackReadinessEnvelope,
} from "@discord-meeting/conversation-runtime-contracts";

import type {
  ConversationPlaybackReadinessPort,
  ConversationPlaybackReadinessRequest,
  ConversationPortResult,
} from "@discord-meeting/meeting-core/conversation";
const pollIntervalMilliseconds = 25;
const maximumReceiptBytes = 1_536;

export interface FileConversationPlaybackReadinessOptions {
  readonly root: string;
  readonly runId: string;
  readonly timeoutMilliseconds: number;
}

/** Filesystem adapter for the E2E-only two-phase answer capture protocol. */
export class FileConversationPlaybackReadiness implements ConversationPlaybackReadinessPort {
  readonly #initialized: Promise<void>;

  public constructor(private readonly options: FileConversationPlaybackReadinessOptions) {
    this.#initialized = initializeCleanRunRoot(options.root);
  }

  public async awaitConversationPlaybackReady(
    request: ConversationPlaybackReadinessRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ConversationPortResult<"ready">> {
    if (request.playbackKind !== "answer") {
      return failure("PLAYBACK_READINESS_KIND_INVALID", "Only answer playback can use E2E readiness");
    }
    const envelope = conversationAnswerPlaybackReadinessEnvelopeSchema.parse({
      capturePlan: "addressed-answer",
      kind: request.playbackKind,
      meetingId: request.meetingId,
      playbackAttemptId: request.playbackAttemptId,
      protocolVersion: conversationPlaybackReadinessProtocolVersion,
      runId: this.options.runId,
      turnId: request.turnId,
    });
    try {
      await this.#initialized;
      const intentPublishedNotBeforeEpochMilliseconds = Date.now();
      await publishCreateOnlyJson(this.intentPath(envelope), {
        ...envelope,
        type: "playback-intent",
      });
      await this.waitForExactReady(
        envelope,
        intentPublishedNotBeforeEpochMilliseconds,
        options.signal,
      );
      return { ok: true, value: "ready" };
    } catch (error: unknown) {
      return failure(
        "PLAYBACK_READINESS_FAILED",
        error instanceof Error ? error.message : "Playback observer readiness failed",
      );
    }
  }

  private async waitForExactReady(
    expected: ConversationAnswerPlaybackReadinessEnvelope,
    notBeforeEpochMilliseconds: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const readyPath = this.readyPath(expected);
    const deadline = Date.now() + this.options.timeoutMilliseconds;
    for (;;) {
      assertNotAborted(signal);
      try {
        const bytes = await readStableReceipt(readyPath, notBeforeEpochMilliseconds);
        const ready = conversationAnswerObserverReadySchema.parse(
          JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        );
        if (!sameEnvelope(ready, expected)) {
          throw new Error("Observer-ready receipt does not match the playback intent");
        }
        return;
      } catch (error: unknown) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("Observer-ready receipt was not created before timeout");
      }
      await abortableDelay(Math.min(pollIntervalMilliseconds, remaining), signal);
    }
  }

  private intentPath(envelope: ConversationAnswerPlaybackReadinessEnvelope): string {
    return join(this.options.root, `${safeFileStem(envelope)}.intent.json`);
  }

  private readyPath(envelope: ConversationAnswerPlaybackReadinessEnvelope): string {
    return join(this.options.root, `${safeFileStem(envelope)}.ready.json`);
  }
}

async function initializeCleanRunRoot(root: string): Promise<void> {
  try {
    await assertSafeHandshakeRoot(root);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  await assertSafeHandshakeRoot(root);
  const entries = await readdir(root);
  if (entries.some((name) => /^(?:[a-f\d]{64})\.(?:intent|ready)\.json$/u.test(name))) {
    throw new Error("Playback readiness run root contains stale handshake receipts");
  }
}

async function assertSafeHandshakeRoot(root: string): Promise<void> {
  const stats = await lstat(root);
  if (!stats.isDirectory()) {
    throw new Error("Playback readiness root must be a real directory");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error("Playback readiness root permissions are too broad");
  }
}

async function readStableReceipt(
  path: string,
  notBeforeEpochMilliseconds: number,
): Promise<Uint8Array> {
  const pathStats = await lstat(path);
  assertSafeReadyStats(pathStats, notBeforeEpochMilliseconds);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const beforeRead = await handle.stat();
    assertSafeReadyStats(beforeRead, notBeforeEpochMilliseconds);
    if (beforeRead.dev !== pathStats.dev || beforeRead.ino !== pathStats.ino) {
      throw new Error("Observer-ready receipt changed before read");
    }
    const bytes = new Uint8Array(maximumReceiptBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    const afterRead = await handle.stat();
    if (afterRead.dev !== beforeRead.dev || afterRead.ino !== beforeRead.ino ||
      afterRead.size !== beforeRead.size || afterRead.mtimeMs !== beforeRead.mtimeMs ||
      bytesRead !== beforeRead.size) {
      throw new Error("Observer-ready receipt changed while reading");
    }
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function assertSafeReadyStats(
  stats: Awaited<ReturnType<typeof lstat>>,
  notBeforeEpochMilliseconds: number,
): void {
  if (!stats.isFile()) {
    throw new Error("Observer-ready receipt must be a regular file");
  }
  if (stats.size <= 0 || stats.size > maximumReceiptBytes) {
    throw new Error("Observer-ready receipt has an invalid size");
  }
  if (stats.mtimeMs < notBeforeEpochMilliseconds) {
    throw new Error("Observer-ready receipt predates its playback intent");
  }
}

function safeFileStem(envelope: ConversationAnswerPlaybackReadinessEnvelope): string {
  return createHash("sha256")
    .update(serializeConversationAnswerPlaybackReadinessEnvelope(envelope))
    .digest("hex");
}

async function publishCreateOnlyJson(path: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(conversationAnswerPlaybackIntentSchema.parse(value));
  if (Buffer.byteLength(encoded, "utf8") > maximumReceiptBytes) {
    throw new Error("Playback intent is too large");
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

function sameEnvelope(
  actual: ReturnType<typeof conversationAnswerObserverReadySchema.parse>,
  expected: ConversationAnswerPlaybackReadinessEnvelope,
): boolean {
  return actual.meetingId === expected.meetingId &&
    actual.playbackAttemptId === expected.playbackAttemptId &&
    actual.runId === expected.runId &&
    actual.turnId === expected.turnId &&
    actual.intentDigestSha256 === safeFileStem(expected) &&
    actual.authenticatedObserverBotId === actual.target.observerApplicationId &&
    Date.parse(actual.intentObservedAt) <= Date.parse(actual.readyPublishedAt);
}

function failure(
  code: string,
  message: string,
): ConversationPortResult<"ready"> {
  return { failure: { code, message, retryable: false }, ok: false };
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("Playback observer readiness was cancelled");
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new Error("Playback observer readiness was cancelled"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
