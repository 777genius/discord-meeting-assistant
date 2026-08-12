import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  serializeConversationAnswerPlaybackReadinessEnvelope,
  type ConversationAnswerPlaybackIntent,
} from "@discord-meeting/conversation-runtime-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertConversationAnswerHandshakeRootIsNew,
  publishConversationAnswerObserverReady,
  waitForConversationAnswerPlaybackIntent,
} from "../src/conversation-voice-turn-id-source.js";

const roots: string[] = [];
const intent: ConversationAnswerPlaybackIntent = {
  capturePlan: "addressed-answer", kind: "answer", meetingId: "meeting-1",
  playbackAttemptId: "answer-attempt-1", protocolVersion: 1, runId: "run-1",
  turnId: "human-question-17", type: "playback-intent",
};

afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { force: true, recursive: true }))));

describe("conversation answer playback readiness source", () => {
  it("waits for an exact fresh intent and publishes a create-only ready receipt", async () => {
    const root = await temporaryRoot();
    await assertConversationAnswerHandshakeRootIsNew(root);
    const waiting = waitForConversationAnswerPlaybackIntent({
      meetingId: intent.meetingId, notBeforeEpochMilliseconds: Date.now(), root,
      runId: intent.runId, timeoutMilliseconds: 1_000,
    });
    await publishIntent(root);
    const resolved = await waiting;
    expect(resolved).toEqual(intent);
    await publishConversationAnswerObserverReady({ intent: resolved, root });
    expect(JSON.parse(await readFile(join(root, `${stem()}.ready.json`), "utf8")))
      .toEqual({ ...intent, type: "observer-ready" });
    await expect(publishConversationAnswerObserverReady({ intent: resolved, root }))
      .rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects stale roots and wrong run bindings", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, `${stem()}.intent.json`), JSON.stringify(intent), { flag: "wx" });
    await expect(assertConversationAnswerHandshakeRootIsNew(root)).rejects.toThrow("stale");
    await expect(waitForConversationAnswerPlaybackIntent({
      meetingId: intent.meetingId, notBeforeEpochMilliseconds: 0, root,
      runId: "other-run", timeoutMilliseconds: 100,
    })).rejects.toThrow("wrong run or meeting");
  });

  it("rejects a symlink handshake root and overly broad root permissions", async () => {
    const parent = await temporaryRoot();
    const target = join(parent, "target");
    const linkedRoot = join(parent, "linked-root");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linkedRoot);
    await expect(assertConversationAnswerHandshakeRootIsNew(linkedRoot))
      .rejects.toThrow("real directory");

    await chmod(target, 0o755);
    await expect(assertConversationAnswerHandshakeRootIsNew(target))
      .rejects.toThrow("permissions");
  });

  it("rejects stale, symlink and non-regular playback intents", async () => {
    for (const receiptKind of ["stale", "symlink", "directory"] as const) {
      const root = await temporaryRoot();
      const path = join(root, `${stem()}.intent.json`);
      if (receiptKind === "stale") {
        await writeFile(path, JSON.stringify(intent), { flag: "wx" });
        await utimes(path, new Date(0), new Date(0));
      } else if (receiptKind === "symlink") {
        const target = join(root, "intent-target.json");
        await writeFile(target, JSON.stringify(intent));
        await symlink(target, path);
      } else {
        await mkdir(path);
      }
      await expect(waitForConversationAnswerPlaybackIntent({
        meetingId: intent.meetingId, notBeforeEpochMilliseconds: Date.now(), root,
        runId: intent.runId, timeoutMilliseconds: 100,
      })).rejects.toThrow(receiptKind === "stale" ? "stale" : "regular file");
    }
  });

  it("clears its polling timer when intent waiting is cancelled", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const nativeSetTimeout = globalThis.setTimeout;
    let confirmPollingTimer: (() => void) | undefined;
    const pollingTimerScheduled = new Promise<void>((resolve) => {
      confirmPollingTimer = resolve;
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (handler, timeout) => {
        const timer = nativeSetTimeout(handler, timeout);
        if (timeout === 25) {
          confirmPollingTimer?.();
        }
        return timer;
      },
    );
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const waiting = waitForConversationAnswerPlaybackIntent({
      meetingId: intent.meetingId, notBeforeEpochMilliseconds: Date.now(), root,
      runId: intent.runId, signal: controller.signal, timeoutMilliseconds: 1_000,
    });
    await pollingTimerScheduled;
    controller.abort();

    await expect(waiting).rejects.toThrow("cancelled");
    expect(clearTimeoutSpy).toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});

function stem(): string {
  return createHash("sha256")
    .update(serializeConversationAnswerPlaybackReadinessEnvelope(intent)).digest("hex");
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "answer-readiness-"));
  roots.push(root);
  return root;
}

async function publishIntent(root: string): Promise<void> {
  const path = join(root, `${stem()}.intent.json`);
  const temporaryPath = join(root, `.${stem()}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, JSON.stringify(intent), { flag: "wx", mode: 0o600 });
  try {
    await link(temporaryPath, path);
  } finally {
    await unlink(temporaryPath);
  }
}
