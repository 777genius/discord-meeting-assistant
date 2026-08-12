import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeConversationAnswerPlaybackReadinessEnvelope } from
  "@discord-meeting/conversation-runtime-contracts";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileConversationPlaybackReadiness } from
  "../src/adapters/outbound/file-conversation-playback-readiness.js";

const temporaryRoots: string[] = [];
const request = {
  meetingId: "meeting-1",
  playbackAttemptId: "answer-attempt-1",
  playbackKind: "answer" as const,
  turnId: "human-question-1",
};
const envelope = {
  capturePlan: "addressed-answer" as const,
  kind: "answer" as const,
  meetingId: request.meetingId,
  playbackAttemptId: request.playbackAttemptId,
  protocolVersion: 1 as const,
  runId: "run-1",
  turnId: request.turnId,
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("FileConversationPlaybackReadiness", () => {
  it("publishes a create-only intent and waits for the exact observer-ready receipt", async () => {
    const root = await temporaryRoot();
    const readiness = new FileConversationPlaybackReadiness({
      root,
      runId: envelope.runId,
      timeoutMilliseconds: 1_000,
    });

    const waiting = readiness.awaitConversationPlaybackReady(request);
    const intent = await waitForJson(intentPath(root));
    expect(intent).toEqual({ ...envelope, type: "playback-intent" });
    await writeFile(
      readyPath(root),
      JSON.stringify({ ...envelope, type: "observer-ready" }),
      { flag: "wx", mode: 0o600 },
    );

    await expect(waiting).resolves.toEqual({ ok: true, value: "ready" });
  });

  it.each([
    ["wrong attempt", { ...envelope, playbackAttemptId: "cue-attempt" }],
    ["wrong run", { ...envelope, runId: "other-run" }],
    ["cue kind", { ...envelope, kind: "thinking-cue" }],
  ])("fails closed for %s in the ready receipt", async (_name, receipt) => {
    const root = await temporaryRoot();
    const readiness = new FileConversationPlaybackReadiness({
      root,
      runId: envelope.runId,
      timeoutMilliseconds: 1_000,
    });

    const waiting = readiness.awaitConversationPlaybackReady(request);
    await waitForJson(intentPath(root));
    await writeFile(
      readyPath(root),
      JSON.stringify({ ...receipt, type: "observer-ready" }),
      { flag: "wx", mode: 0o600 },
    );

    await expect(waiting).resolves.toMatchObject({
      failure: { code: "PLAYBACK_READINESS_FAILED" },
      ok: false,
    });
  });

  it("fails closed when observer readiness times out", async () => {
    const root = await temporaryRoot();
    const readiness = new FileConversationPlaybackReadiness({
      root,
      runId: envelope.runId,
      timeoutMilliseconds: 30,
    });

    await expect(readiness.awaitConversationPlaybackReady(request)).resolves.toMatchObject({
      failure: {
        code: "PLAYBACK_READINESS_FAILED",
        message: expect.stringContaining("before timeout"),
      },
      ok: false,
    });
  });

  it("rejects a readiness root that is a symlink", async () => {
    const parent = await temporaryRoot();
    const target = join(parent, "target");
    const root = join(parent, "linked-root");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, root);
    const readiness = new FileConversationPlaybackReadiness({
      root, runId: envelope.runId, timeoutMilliseconds: 30,
    });

    await expect(readiness.awaitConversationPlaybackReady(request)).resolves.toMatchObject({
      failure: { message: expect.stringContaining("real directory") }, ok: false,
    });
  });

  it("rejects a readiness root with group or world access", async () => {
    const root = await temporaryRoot();
    await chmod(root, 0o755);
    const readiness = new FileConversationPlaybackReadiness({
      root, runId: envelope.runId, timeoutMilliseconds: 30,
    });

    await expect(readiness.awaitConversationPlaybackReady(request)).resolves.toMatchObject({
      failure: { message: expect.stringContaining("permissions") }, ok: false,
    });
  });

  it("rejects stale and non-regular observer-ready receipts", async () => {
    for (const receiptKind of ["stale", "symlink", "directory"] as const) {
      const root = await temporaryRoot();
      const readiness = new FileConversationPlaybackReadiness({
        root, runId: envelope.runId, timeoutMilliseconds: 1_000,
      });
      const waiting = readiness.awaitConversationPlaybackReady(request);
      await waitForJson(intentPath(root));
      const path = readyPath(root);
      if (receiptKind === "stale") {
        await writeFile(path, JSON.stringify({ ...envelope, type: "observer-ready" }), { flag: "wx" });
        await utimes(path, new Date(0), new Date(0));
      } else if (receiptKind === "symlink") {
        const target = join(root, "ready-target.json");
        await writeFile(target, JSON.stringify({ ...envelope, type: "observer-ready" }));
        await symlink(target, path);
      } else {
        await mkdir(path);
      }
      await expect(waiting).resolves.toMatchObject({
        failure: { code: "PLAYBACK_READINESS_FAILED" }, ok: false,
      });
    }
  });

  it("fails closed on a create-only intent collision", async () => {
    const root = await temporaryRoot();
    const readiness = new FileConversationPlaybackReadiness({
      root, runId: envelope.runId, timeoutMilliseconds: 1_000,
    });
    const first = readiness.awaitConversationPlaybackReady(request);
    await waitForJson(intentPath(root));
    await writeFile(readyPath(root), JSON.stringify({ ...envelope, type: "observer-ready" }), { flag: "wx" });
    await expect(first).resolves.toEqual({ ok: true, value: "ready" });
    await expect(readiness.awaitConversationPlaybackReady(request)).resolves.toMatchObject({
      failure: { code: "PLAYBACK_READINESS_FAILED" }, ok: false,
    });
  });

  it("clears its polling timer when observer readiness is cancelled", async () => {
    const root = await temporaryRoot();
    const readiness = new FileConversationPlaybackReadiness({
      root, runId: envelope.runId, timeoutMilliseconds: 1_000,
    });
    const controller = new AbortController();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const waiting = readiness.awaitConversationPlaybackReady(request, {
      signal: controller.signal,
    });
    await waitForJson(intentPath(root));
    controller.abort();

    await expect(waiting).resolves.toMatchObject({
      failure: { message: expect.stringContaining("cancelled") }, ok: false,
    });
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

function receiptStem(): string {
  return createHash("sha256")
    .update(serializeConversationAnswerPlaybackReadinessEnvelope(envelope)).digest("hex");
}

function intentPath(root: string): string {
  return join(root, `${receiptStem()}.intent.json`);
}

function readyPath(root: string): string {
  return join(root, `${receiptStem()}.ready.json`);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conversation-playback-readiness-"));
  temporaryRoots.push(root);
  return root;
}

async function waitForJson(path: string): Promise<unknown> {
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error("Playback intent was not published before timeout");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}
