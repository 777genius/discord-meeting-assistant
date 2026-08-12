import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeConversationAnswerPlaybackReadinessEnvelope } from
  "@discord-meeting/conversation-runtime-contracts";

import { afterEach, describe, expect, it } from "vitest";

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
    const intent = await waitForJson(intentPath(root)) as Record<string, unknown>;
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
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
