import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeConversationAnswerPlaybackReadinessEnvelope,
  serializeConversationGreetingPlaybackReadinessEnvelope,
  serializeConversationThinkingCuePlaybackReadinessEnvelope } from
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
const readyReceipt = {
  ...envelope,
  authenticatedObserverBotId: "1533867700575670282",
  intentDigestSha256: receiptStem(),
  intentObservedAt: "2026-08-12T10:00:00.000Z",
  planDigestSha256: "a".repeat(64),
  readyPublishedAt: "2026-08-12T10:00:00.001Z",
  target: {
    craigBotId: "1534231284467896512",
    guildId: "1533228590643155034",
    observerApplicationId: "1533867700575670282",
    voiceChannelId: "1533228823045214398",
  },
  type: "observer-ready" as const,
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("FileConversationPlaybackReadiness", () => {
  it("gates participant greetings only after the observer binds one meeting", async () => {
    const root = await temporaryRoot();
    const observerParticipantId = "1533867700575670282";
    const participantId = "1533873978417086474";
    const greetingRequest = {
      meetingId: "meeting-1", participantId, playbackAttemptId: "greeting-attempt",
      playbackKind: "prepared-cue" as const, turnId: `participant-greeting:${participantId}`,
    };
    const greetingRoot = await temporaryRoot();
    const readiness = new FileConversationPlaybackReadiness({
      greetingObserverParticipantId: observerParticipantId, greetingRoot, root, runId: "run-1", timeoutMilliseconds: 1_000,
    });
    await expect(readiness.awaitConversationPlaybackReady(greetingRequest))
      .resolves.toEqual({ ok: true, value: "ready" });
    await expect(readiness.awaitConversationPlaybackReady({
      ...greetingRequest, turnId: "ordinary-prepared-cue",
    })).resolves.toEqual({ ok: true, value: "ready" });
    await completeGreetingReadiness(readiness, greetingRoot, {
      ...greetingRequest,
      participantId: observerParticipantId,
      turnId: `participant-greeting:${observerParticipantId}`,
    }, observerParticipantId);
    await completeGreetingReadiness(
      readiness, greetingRoot, greetingRequest, observerParticipantId,
    );
    await expect(readiness.awaitConversationPlaybackReady({
      ...greetingRequest, meetingId: "meeting-2",
    })).resolves.toEqual({ ok: true, value: "ready" });
  });

  it("publishes and verifies an exact thinking-cue observer handshake", async () => {
    const root = await temporaryRoot();
    const cueRequest = {
      ...request,
      expectedPcmBytes: 96_000,
      expectedPcmSha256: "b".repeat(64),
      playbackAttemptId: "thinking-cue-attempt-1",
      playbackKind: "thinking-cue" as const,
    };
    const cueEnvelope = {
      capturePlan: "thinking-cue" as const,
      expectedPcmBytes: cueRequest.expectedPcmBytes,
      expectedPcmSha256: cueRequest.expectedPcmSha256,
      kind: "thinking-cue" as const,
      meetingId: cueRequest.meetingId,
      playbackAttemptId: cueRequest.playbackAttemptId,
      protocolVersion: 2 as const,
      runId: envelope.runId,
      turnId: cueRequest.turnId,
    };
    const stem = createHash("sha256")
      .update(serializeConversationThinkingCuePlaybackReadinessEnvelope(cueEnvelope))
      .digest("hex");
    const readiness = new FileConversationPlaybackReadiness({
      root, runId: envelope.runId, timeoutMilliseconds: 1_000,
    });

    const waiting = readiness.awaitConversationPlaybackReady(cueRequest);
    await expect(waitForJson(join(root, `${stem}.intent.json`))).resolves.toEqual({
      ...cueEnvelope, type: "playback-intent",
    });
    await publishCreateOnlyJson(join(root, `${stem}.ready.json`), {
      ...cueEnvelope,
      authenticatedObserverBotId: readyReceipt.authenticatedObserverBotId,
      intentDigestSha256: stem,
      intentObservedAt: readyReceipt.intentObservedAt,
      readyPublishedAt: readyReceipt.readyPublishedAt,
      target: readyReceipt.target,
      type: "observer-ready",
    });

    await expect(waiting).resolves.toEqual({ ok: true, value: "ready" });
  });

  it("rejects a same-length cue readiness receipt with the wrong PCM digest", async () => {
    const root = await temporaryRoot();
    const cueRequest = {
      ...request,
      expectedPcmBytes: 96_000,
      expectedPcmSha256: "b".repeat(64),
      playbackAttemptId: "thinking-cue-attempt-corrupt",
      playbackKind: "thinking-cue" as const,
    };
    const cueEnvelope = {
      capturePlan: "thinking-cue" as const,
      expectedPcmBytes: cueRequest.expectedPcmBytes,
      expectedPcmSha256: cueRequest.expectedPcmSha256,
      kind: "thinking-cue" as const,
      meetingId: cueRequest.meetingId,
      playbackAttemptId: cueRequest.playbackAttemptId,
      protocolVersion: 2 as const,
      runId: envelope.runId,
      turnId: cueRequest.turnId,
    };
    const stem = createHash("sha256")
      .update(serializeConversationThinkingCuePlaybackReadinessEnvelope(cueEnvelope))
      .digest("hex");
    const readiness = new FileConversationPlaybackReadiness({
      root, runId: envelope.runId, timeoutMilliseconds: 1_000,
    });

    const waiting = readiness.awaitConversationPlaybackReady(cueRequest);
    await waitForJson(join(root, `${stem}.intent.json`));
    await writeFile(join(root, `${stem}.ready.json`), JSON.stringify({
      ...cueEnvelope,
      authenticatedObserverBotId: readyReceipt.authenticatedObserverBotId,
      expectedPcmSha256: "c".repeat(64),
      intentDigestSha256: stem,
      intentObservedAt: readyReceipt.intentObservedAt,
      readyPublishedAt: readyReceipt.readyPublishedAt,
      target: readyReceipt.target,
      type: "observer-ready",
    }), { flag: "wx", mode: 0o600 });

    await expect(waiting).resolves.toMatchObject({
      failure: { code: "PLAYBACK_READINESS_FAILED" },
      ok: false,
    });
  });
});

describe("FileConversationPlaybackReadiness answer handshakes", () => {
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
    await publishCreateOnlyJson(readyPath(root), readyReceipt);

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
    await publishCreateOnlyJson(
      readyPath(root),
      { ...readyReceipt, ...receipt, type: "observer-ready" },
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

    const result = await readiness.awaitConversationPlaybackReady(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("PLAYBACK_READINESS_FAILED");
      expect(result.failure.message).toContain("before timeout");
    }
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

    const result = await readiness.awaitConversationPlaybackReady(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("real directory");
    }
  });

  it("rejects a readiness root with group or world access", async () => {
    const root = await temporaryRoot();
    await chmod(root, 0o755);
    const readiness = new FileConversationPlaybackReadiness({
      root, runId: envelope.runId, timeoutMilliseconds: 30,
    });

    const result = await readiness.awaitConversationPlaybackReady(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("permissions");
    }
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
        await publishCreateOnlyJson(path, readyReceipt, new Date(0));
      } else if (receiptKind === "symlink") {
        const target = join(root, "ready-target.json");
        await writeFile(target, JSON.stringify(readyReceipt));
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
    await publishCreateOnlyJson(readyPath(root), readyReceipt);
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
    const originalSetTimeout = globalThis.setTimeout;
    let cancellationScheduled = false;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (callback, milliseconds, ...arguments_) => {
        const timeout = originalSetTimeout(callback, milliseconds, ...arguments_);
        if (milliseconds === 25 && !cancellationScheduled) {
          cancellationScheduled = true;
          queueMicrotask(() => {
            controller.abort();
          });
        }
        return timeout;
      },
    );
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const result = await readiness.awaitConversationPlaybackReady(request, {
        signal: controller.signal,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.message).toContain("cancelled");
      }
      expect(cancellationScheduled).toBe(true);
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
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

async function completeGreetingReadiness(
  readiness: FileConversationPlaybackReadiness,
  greetingRoot: string,
  greetingRequest: {
    readonly meetingId: string;
    readonly participantId: string;
    readonly playbackAttemptId: string;
    readonly playbackKind: "prepared-cue";
    readonly turnId: string;
  },
  observerParticipantId: string,
): Promise<void> {
  const greetingEnvelope = {
    capturePlan: "observer-greeting" as const, kind: "greeting" as const,
    meetingId: greetingRequest.meetingId, participantId: greetingRequest.participantId,
    protocolVersion: 1 as const, runId: "run-1", turnId: greetingRequest.turnId,
  };
  const stem = createHash("sha256")
    .update(serializeConversationGreetingPlaybackReadinessEnvelope(greetingEnvelope)).digest("hex");
  const waiting = readiness.awaitConversationPlaybackReady(greetingRequest);
  await waitForJson(join(greetingRoot, `${stem}.intent.json`));
  await publishCreateOnlyJson(join(greetingRoot, `${stem}.ready.json`), {
    ...greetingEnvelope, authenticatedObserverBotId: observerParticipantId,
    intentDigestSha256: stem, intentObservedAt: "2026-08-12T10:00:00.000Z",
    readyPublishedAt: "2026-08-12T10:00:00.001Z",
    target: { craigBotId: "1534231284467896512", guildId: "1533228590643155034",
      observerApplicationId: observerParticipantId, voiceChannelId: "1533228823045214398" },
    type: "observer-ready",
  });
  await expect(waiting).resolves.toEqual({ ok: true, value: "ready" });
}

async function publishCreateOnlyJson(
  path: string,
  value: unknown,
  modifiedAt?: Date,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try {
    if (modifiedAt !== undefined) {
      await utimes(temporaryPath, modifiedAt, modifiedAt);
    }
    await link(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
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
