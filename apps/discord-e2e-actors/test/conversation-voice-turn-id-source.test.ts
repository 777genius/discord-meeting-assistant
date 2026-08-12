import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  serializeConversationAnswerPlaybackReadinessEnvelope,
  type ConversationAnswerPlaybackIntent,
} from "@discord-meeting/conversation-runtime-contracts";
import { afterEach, describe, expect, it } from "vitest";

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
    await writeFile(join(root, `${stem()}.intent.json`), JSON.stringify(intent), { flag: "wx" });
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
