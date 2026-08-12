import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertConversationVoiceTurnIdFileIsNew,
  publishNewConversationVoiceTurnIdFile,
  readConversationVoiceTurnIdFile,
  waitForNewConversationVoiceTurnIdFile,
} from "../src/conversation-voice-turn-id-source.js";

describe("conversation voice turn ID source", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("accepts an absent create-only path and rejects a pre-existing source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conversation-turn-id-"));
    const path = join(directory, "turn-id.txt");
    await expect(assertConversationVoiceTurnIdFileIsNew(path)).resolves.toBeUndefined();
    await writeFile(path, "turn-1", { flag: "wx" });
    await expect(assertConversationVoiceTurnIdFileIsNew(path)).rejects.toThrow("must not exist");
  });

  it("waits for a new valid creation and returns exactly one correlation ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conversation-turn-id-"));
    const path = join(directory, "turn-id.txt");
    const notBeforeEpochMilliseconds = Date.now();
    const resolved = waitForNewConversationVoiceTurnIdFile({
      notBeforeEpochMilliseconds,
      path,
      timeoutMilliseconds: 1_000,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    await writeFile(path, "human-question-17\n", { flag: "wx" });
    await expect(resolved).resolves.toBe("human-question-17");
  });

  it("rejects stale, symlink, non-regular, oversized, and invalid sources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conversation-turn-id-"));
    const stalePath = join(directory, "stale.txt");
    await writeFile(stalePath, "turn-stale", { flag: "wx" });
    const notBeforeEpochMilliseconds = Date.now();
    await utimes(stalePath, new Date(0), new Date(0));
    await expect(resolveTurnId(stalePath, notBeforeEpochMilliseconds)).rejects.toThrow("stale");

    const targetPath = join(directory, "target.txt");
    const symlinkPath = join(directory, "symlink.txt");
    await writeFile(targetPath, "turn-target", { flag: "wx" });
    await symlink(targetPath, symlinkPath);
    await expect(resolveTurnId(symlinkPath, 0)).rejects.toThrow("regular file");

    const directoryPath = join(directory, "nested");
    await mkdir(directoryPath);
    await expect(resolveTurnId(directoryPath, 0)).rejects.toThrow("regular file");

    const oversizedPath = join(directory, "oversized.txt");
    await writeFile(oversizedPath, "x".repeat(258), { flag: "wx" });
    await expect(resolveTurnId(oversizedPath, 0)).rejects.toThrow("invalid size");

    const invalidPath = join(directory, "invalid.txt");
    await writeFile(invalidPath, "two ids\nturn-2", { flag: "wx" });
    await expect(resolveTurnId(invalidPath, 0)).rejects.toThrow("invalid correlation ID");

    const invalidUtf8Path = join(directory, "invalid-utf8.txt");
    await writeFile(invalidUtf8Path, new Uint8Array([0xff]), { flag: "wx" });
    await expect(resolveTurnId(invalidUtf8Path, 0)).rejects.toThrow("encoded data was not valid");
  });

  it("fails within the bounded wait when the source is never created", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conversation-turn-id-"));
    await expect(waitForNewConversationVoiceTurnIdFile({
      notBeforeEpochMilliseconds: Date.now(),
      path: join(directory, "missing.txt"),
      timeoutMilliseconds: 30,
    })).rejects.toThrow("before timeout");
  });

  it("cancels a missing-file poll without leaving its timer alive", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "conversation-turn-id-"));
    const cancellation = new AbortController();
    const waiting = waitForNewConversationVoiceTurnIdFile({
      notBeforeEpochMilliseconds: Date.now(),
      path: join(directory, "missing.txt"),
      signal: cancellation.signal,
      timeoutMilliseconds: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    cancellation.abort();

    await expect(waiting).rejects.toThrow("was cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not block if a checked regular path is replaced by a FIFO before open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conversation-turn-id-"));
    const path = join(directory, "turn-id.txt");
    const originalPath = join(directory, "turn-id.original.txt");
    const fifoPath = join(directory, "turn-id.fifo");
    await writeFile(path, "turn-original", { flag: "wx" });
    await createFifo(fifoPath);

    await expect(readConversationVoiceTurnIdFile({
      afterPathInspection: async () => {
        await rename(path, originalPath);
        await rename(fifoPath, path);
      },
      notBeforeEpochMilliseconds: 0,
      path,
    })).rejects.toThrow("regular file");
  });

  it("publishes a fully written create-only file and never replaces a collision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conversation-turn-id-"));
    const path = join(directory, "turn-id.txt");
    const publication = publishNewConversationVoiceTurnIdFile({
      path,
      turnId: "human-question-23",
    });
    const visibleContents = observeFirstVisibleContents(path);

    await expect(publication).resolves.toBeUndefined();
    await expect(visibleContents).resolves.toBe("human-question-23");
    expect(await readdir(directory)).toEqual(["turn-id.txt"]);

    await expect(publishNewConversationVoiceTurnIdFile({
      path,
      turnId: "replacement-turn",
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("human-question-23");
    expect(await readdir(directory)).toEqual(["turn-id.txt"]);
  });

  it("publishes live turn IDs without rebuilding during the handoff", async () => {
    const packageJson = JSON.parse(await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as { readonly scripts?: Record<string, string> };

    expect(packageJson.scripts?.["publish:conversation-turn-id"])
      .toBe("node dist/publish-conversation-voice-turn-id.js");
  });
});

async function resolveTurnId(path: string, notBeforeEpochMilliseconds: number): Promise<string> {
  return waitForNewConversationVoiceTurnIdFile({
    notBeforeEpochMilliseconds,
    path,
    timeoutMilliseconds: 100,
  });
}

async function createFifo(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("mkfifo", [path], (error) => {
      if (error === null) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

async function observeFirstVisibleContents(path: string): Promise<string> {
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
