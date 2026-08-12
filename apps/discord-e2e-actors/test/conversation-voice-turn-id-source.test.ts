import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertConversationAnswerPlaybackStartReceipt,
  assertConversationAnswerPlaybackStartReceiptFileIsNew,
  publishNewConversationAnswerPlaybackStartReceiptFile,
  readConversationAnswerPlaybackStartReceiptFile,
  waitForNewConversationAnswerPlaybackStartReceiptFile,
  type ConversationAnswerPlaybackStartReceipt,
} from "../src/conversation-voice-turn-id-source.js";

const receipt: ConversationAnswerPlaybackStartReceipt = {
  kind: "answer",
  meetingId: "meeting-1",
  playbackAttemptId: "answer-attempt-1",
  runId: "run-1",
  schemaVersion: 1,
  startedAt: { epochMilliseconds: 1_000, monotonicMilliseconds: 500 },
  turnId: "human-question-17",
};

describe("conversation answer playback-start receipt source", () => {
  afterEach(() => vi.useRealTimers());

  it("validates the exact privacy-safe receipt contract", () => {
    expect(assertConversationAnswerPlaybackStartReceipt(receipt)).toEqual(receipt);
    expect(() => assertConversationAnswerPlaybackStartReceipt({ ...receipt, kind: "thinking-cue" }))
      .toThrow();
    expect(() => assertConversationAnswerPlaybackStartReceipt({ ...receipt, answer: "private" }))
      .toThrow();
    expect(() => assertConversationAnswerPlaybackStartReceipt({
      ...receipt,
      startedAt: { epochMilliseconds: 0, monotonicMilliseconds: -1 },
    })).toThrow();
  });

  it("accepts an absent create-only path and rejects a pre-existing source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "answer-playback-receipt-"));
    const path = join(directory, "receipt.json");
    await expect(assertConversationAnswerPlaybackStartReceiptFileIsNew(path))
      .resolves.toBeUndefined();
    await writeFile(path, JSON.stringify(receipt), { flag: "wx" });
    await expect(assertConversationAnswerPlaybackStartReceiptFileIsNew(path))
      .rejects.toThrow("must not exist");
  });

  it("waits for a new valid receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "answer-playback-receipt-"));
    const path = join(directory, "receipt.json");
    const resolved = waitForNewConversationAnswerPlaybackStartReceiptFile({
      notBeforeEpochMilliseconds: Date.now(), path, timeoutMilliseconds: 1_000,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    await writeFile(path, JSON.stringify(receipt), { flag: "wx" });
    await expect(resolved).resolves.toEqual(receipt);
  });

  it("rejects stale, symlink, non-regular, oversized, malformed, and invalid sources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "answer-playback-receipt-"));
    const stalePath = join(directory, "stale.json");
    await writeFile(stalePath, JSON.stringify(receipt), { flag: "wx" });
    const notBeforeEpochMilliseconds = Date.now();
    await utimes(stalePath, new Date(0), new Date(0));
    await expect(resolveReceipt(stalePath, notBeforeEpochMilliseconds)).rejects.toThrow("stale");

    const targetPath = join(directory, "target.json");
    const symlinkPath = join(directory, "symlink.json");
    await writeFile(targetPath, JSON.stringify(receipt), { flag: "wx" });
    await symlink(targetPath, symlinkPath);
    await expect(resolveReceipt(symlinkPath, 0)).rejects.toThrow("regular file");

    const directoryPath = join(directory, "nested");
    await mkdir(directoryPath);
    await expect(resolveReceipt(directoryPath, 0)).rejects.toThrow("regular file");

    const oversizedPath = join(directory, "oversized.json");
    await writeFile(oversizedPath, "x".repeat(1_537), { flag: "wx" });
    await expect(resolveReceipt(oversizedPath, 0)).rejects.toThrow("invalid size");

    const malformedPath = join(directory, "malformed.json");
    await writeFile(malformedPath, "{", { flag: "wx" });
    await expect(resolveReceipt(malformedPath, 0)).rejects.toThrow();

    const invalidPath = join(directory, "invalid.json");
    await writeFile(invalidPath, JSON.stringify({ ...receipt, runId: "contains space" }), { flag: "wx" });
    await expect(resolveReceipt(invalidPath, 0)).rejects.toThrow();
  });

  it("supports bounded timeout and abort without a live timer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "answer-playback-receipt-"));
    const path = join(directory, "missing.json");
    await expect(waitForNewConversationAnswerPlaybackStartReceiptFile({
      notBeforeEpochMilliseconds: Date.now(), path, timeoutMilliseconds: 30,
    })).rejects.toThrow("before timeout");

    vi.useFakeTimers();
    const cancellation = new AbortController();
    const waiting = waitForNewConversationAnswerPlaybackStartReceiptFile({
      notBeforeEpochMilliseconds: Date.now(), path, signal: cancellation.signal,
      timeoutMilliseconds: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    cancellation.abort();
    await expect(waiting).rejects.toThrow("was cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not block if a checked regular path is replaced by a FIFO before open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "answer-playback-receipt-"));
    const path = join(directory, "receipt.json");
    const originalPath = join(directory, "original.json");
    const fifoPath = join(directory, "receipt.fifo");
    await writeFile(path, JSON.stringify(receipt), { flag: "wx" });
    await createFifo(fifoPath);
    await expect(readConversationAnswerPlaybackStartReceiptFile({
      afterPathInspection: async () => { await rename(path, originalPath); await rename(fifoPath, path); },
      notBeforeEpochMilliseconds: 0, path,
    })).rejects.toThrow("regular file");
  });

  it("publishes fully written 0600 JSON create-only and never replaces a collision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "answer-playback-receipt-"));
    const path = join(directory, "receipt.json");
    const publication = publishNewConversationAnswerPlaybackStartReceiptFile({ path, receipt });
    const visibleContents = observeFirstVisibleContents(path);
    await expect(publication).resolves.toBeUndefined();
    await expect(visibleContents).resolves.toBe(JSON.stringify(receipt));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["receipt.json"]);
    await expect(publishNewConversationAnswerPlaybackStartReceiptFile({
      path, receipt: { ...receipt, turnId: "replacement" },
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt);
  });

  it("exposes a no-rebuild structured publisher script", async () => {
    const packageJson: unknown = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (!hasScripts(packageJson)) {
      throw new Error("Actor package scripts are missing");
    }
    expect(packageJson.scripts?.["publish:conversation-answer-playback-start"])
      .toBe("node dist/publish-conversation-voice-turn-id.js");
  });
});

async function resolveReceipt(path: string, notBeforeEpochMilliseconds: number) {
  return waitForNewConversationAnswerPlaybackStartReceiptFile({
    notBeforeEpochMilliseconds, path, timeoutMilliseconds: 100,
  });
}

async function createFifo(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("mkfifo", [path], (error) => {
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function observeFirstVisibleContents(path: string): Promise<string> {
  const startedAt = process.hrtime.bigint();
  for (;;) {
    try { return await readFile(path, "utf8"); } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (process.hrtime.bigint() - startedAt > 5_000_000_000n) {
      throw new Error("Receipt was not visible before timeout");
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function hasScripts(value: unknown): value is { readonly scripts: Record<string, string> } {
  return typeof value === "object" && value !== null && "scripts" in value &&
    typeof value.scripts === "object" && value.scripts !== null;
}
