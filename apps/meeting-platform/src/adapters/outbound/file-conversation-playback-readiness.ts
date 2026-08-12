import { createHash, randomUUID } from "node:crypto";
import { constants, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  ConversationPlaybackReadinessPort,
  ConversationPlaybackReadinessRequest,
  ConversationPortResult,
} from "@discord-meeting/meeting-core/conversation";
import { z } from "zod";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const envelopeSchema = z.object({
  kind: z.literal("answer"),
  meetingId: identifierSchema,
  playbackAttemptId: identifierSchema,
  protocolVersion: z.literal(1),
  runId: identifierSchema,
  turnId: identifierSchema,
}).strict();
const intentSchema = envelopeSchema.extend({ type: z.literal("playback-intent") }).strict();
const readySchema = envelopeSchema.extend({ type: z.literal("observer-ready") }).strict();
const pollIntervalMilliseconds = 25;
const maximumReceiptBytes = 1_536;

export interface FileConversationPlaybackReadinessOptions {
  readonly root: string;
  readonly runId: string;
  readonly timeoutMilliseconds: number;
}

/** Filesystem adapter for the E2E-only two-phase answer capture protocol. */
export class FileConversationPlaybackReadiness implements ConversationPlaybackReadinessPort {
  public constructor(private readonly options: FileConversationPlaybackReadinessOptions) {}

  public async awaitConversationPlaybackReady(
    request: ConversationPlaybackReadinessRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ConversationPortResult<"ready">> {
    if (request.playbackKind !== "answer") {
      return failure("PLAYBACK_READINESS_KIND_INVALID", "Only answer playback can use E2E readiness");
    }
    const envelope = envelopeSchema.parse({
      kind: request.playbackKind,
      meetingId: request.meetingId,
      playbackAttemptId: request.playbackAttemptId,
      protocolVersion: 1,
      runId: this.options.runId,
      turnId: request.turnId,
    });
    try {
      await mkdir(this.options.root, { recursive: true, mode: 0o700 });
      await publishCreateOnlyJson(this.intentPath(envelope), {
        ...envelope,
        type: "playback-intent",
      });
      await this.waitForExactReady(envelope, options.signal);
      return { ok: true, value: "ready" };
    } catch (error: unknown) {
      return failure(
        "PLAYBACK_READINESS_FAILED",
        error instanceof Error ? error.message : "Playback observer readiness failed",
      );
    }
  }

  private async waitForExactReady(
    expected: z.infer<typeof envelopeSchema>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const readyPath = this.readyPath(expected);
    const deadline = Date.now() + this.options.timeoutMilliseconds;
    for (;;) {
      assertNotAborted(signal);
      try {
        const bytes = await readFile(readyPath);
        if (bytes.byteLength <= 0 || bytes.byteLength > maximumReceiptBytes) {
          throw new Error("Observer-ready receipt has an invalid size");
        }
        const ready = readySchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
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

  private intentPath(envelope: z.infer<typeof envelopeSchema>): string {
    return join(this.options.root, `${safeFileStem(envelope)}.intent.json`);
  }

  private readyPath(envelope: z.infer<typeof envelopeSchema>): string {
    return join(this.options.root, `${safeFileStem(envelope)}.ready.json`);
  }
}

function safeFileStem(envelope: z.infer<typeof envelopeSchema>): string {
  return createHash("sha256")
    .update(JSON.stringify(envelope))
    .digest("hex");
}

async function publishCreateOnlyJson(path: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(intentSchema.parse(value));
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
  actual: z.infer<typeof readySchema>,
  expected: z.infer<typeof envelopeSchema>,
): boolean {
  return actual.kind === expected.kind &&
    actual.meetingId === expected.meetingId &&
    actual.playbackAttemptId === expected.playbackAttemptId &&
    actual.runId === expected.runId &&
    actual.turnId === expected.turnId;
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
