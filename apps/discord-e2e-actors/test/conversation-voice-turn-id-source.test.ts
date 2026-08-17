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
const readyInput = {
  authenticatedObserverBotId: "1533867700575670282",
  intentObservedAt: "2026-08-12T10:00:00.000Z",
  planDigestSha256: "a".repeat(64),
  target: {
    craigBotId: "1533877611258708230",
    guildId: "1533228590643155034",
    observerApplicationId: "1533867700575670282",
    voiceChannelId: "1533228823045214398",
  },
} as const;

afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { force: true, recursive: true }))));

describe("conversation answer playback readiness source", () => {
  it("waits for an exact fresh intent and publishes a create-only ready receipt", async () => {
    const root = await temporaryRoot();
    await assertConversationAnswerHandshakeRootIsNew(root);
    const waiting = waitForConversationAnswerPlaybackIntent({
      meetingId: intent.meetingId, notBeforeEpochMilliseconds: Date.now() - 1_000, root,
      runId: intent.runId, timeoutMilliseconds: 1_000,
    });
    await publishIntent(root);
    const resolved = await waiting;
    expect(resolved).toEqual(intent);
    const receipt = await publishConversationAnswerObserverReady({ ...readyInput, intent: resolved, root });
    expect(JSON.parse(await readFile(join(root, `${stem()}.ready.json`), "utf8")))
      .toEqual(receipt);
    expect(receipt).toMatchObject({
      ...intent,
      authenticatedObserverBotId: readyInput.authenticatedObserverBotId,
      intentDigestSha256: stem(),
      planDigestSha256: readyInput.planDigestSha256,
      type: "observer-ready",
    });
    await expect(publishConversationAnswerObserverReady({ ...readyInput, intent: resolved, root }))
      .rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects stale roots and wrong run bindings", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, `${stem()}.intent.json`), JSON.stringify(intent), {
      flag: "wx", mode: 0o600,
    });
    await expect(assertConversationAnswerHandshakeRootIsNew(root)).rejects.toThrow("stale");
    await expect(waitForConversationAnswerPlaybackIntent({
      meetingId: intent.meetingId, notBeforeEpochMilliseconds: 0, root,
      runId: "other-run", timeoutMilliseconds: 100,
    })).rejects.toThrow("wrong run or meeting");
  });

  it("derives the meeting ID from one fresh content-addressed run intent", async () => {
    const root = await temporaryRoot();
    const waiting = waitForConversationAnswerPlaybackIntent({
      notBeforeEpochMilliseconds: Date.now() - 1_000, root,
      runId: intent.runId, timeoutMilliseconds: 1_000,
    });
    await publishIntent(root);

    const resolved = await waiting;
    expect(resolved).toEqual(intent);
    const retainedReadyProof = await publishConversationAnswerObserverReady({
      ...readyInput, intent: resolved, root,
    });
    expect(retainedReadyProof).toMatchObject({
      intentDigestSha256: stem(), meetingId: intent.meetingId, runId: intent.runId,
    });
  });

  it("rejects ambiguous and mismatched intents when deriving the meeting ID", async () => {
    const ambiguousRoot = await temporaryRoot();
    const secondIntent = {
      ...intent,
      meetingId: "meeting-2",
      playbackAttemptId: "answer-attempt-2",
      turnId: "human-question-18",
    };
    await publishIntent(ambiguousRoot, intent);
    await publishIntent(ambiguousRoot, secondIntent);
    await expect(waitForConversationAnswerPlaybackIntent({
      notBeforeEpochMilliseconds: 0, root: ambiguousRoot,
      runId: intent.runId, timeoutMilliseconds: 100,
    })).rejects.toThrow("ambiguous");

    const mismatchedRoot = await temporaryRoot();
    await publishIntent(mismatchedRoot, { ...intent, runId: "other-run" });
    await expect(waitForConversationAnswerPlaybackIntent({
      notBeforeEpochMilliseconds: 0, root: mismatchedRoot,
      runId: intent.runId, timeoutMilliseconds: 100,
    })).rejects.toThrow("wrong run or meeting");
  });

  it("rejects an intent whose filename does not bind its validated envelope", async () => {
    const root = await temporaryRoot();
    const wrongDigest = "f".repeat(64);
    await writeFile(
      join(root, `${wrongDigest}.intent.json`),
      JSON.stringify(intent),
      { flag: "wx", mode: 0o600 },
    );

    await expect(waitForConversationAnswerPlaybackIntent({
      notBeforeEpochMilliseconds: 0, root,
      runId: intent.runId, timeoutMilliseconds: 100,
    })).rejects.toThrow("filename digest is invalid");
  });

  it("rejects malformed content instead of deriving a meeting identity from it", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, `${"e".repeat(64)}.intent.json`),
      JSON.stringify({ ...intent, meetingId: "not a valid meeting id!" }),
      { flag: "wx", mode: 0o600 },
    );

    await expect(waitForConversationAnswerPlaybackIntent({
      notBeforeEpochMilliseconds: 0, root,
      runId: intent.runId, timeoutMilliseconds: 100,
    })).rejects.toThrow();
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
        await writeFile(path, JSON.stringify(intent), { flag: "wx", mode: 0o600 });
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

  it("rejects a playback intent file that is not private", async () => {
    const root = await temporaryRoot();
    const path = join(root, `${stem()}.intent.json`);
    await writeFile(path, JSON.stringify(intent), { flag: "wx", mode: 0o644 });

    await expect(waitForConversationAnswerPlaybackIntent({
      meetingId: intent.meetingId, notBeforeEpochMilliseconds: 0, root,
      runId: intent.runId, timeoutMilliseconds: 100,
    })).rejects.toThrow("mode-0600");
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

async function publishIntent(
  root: string,
  value: ConversationAnswerPlaybackIntent = intent,
): Promise<void> {
  const digest = createHash("sha256")
    .update(serializeConversationAnswerPlaybackReadinessEnvelope(value)).digest("hex");
  const path = join(root, `${digest}.intent.json`);
  const temporaryPath = join(root, `.${digest}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try {
    await link(temporaryPath, path);
  } finally {
    await unlink(temporaryPath);
  }
}
