import { describe, expect, it } from "vitest";

import {
  verifyRetainedE2eEvidence,
  type RetainedE2eEvidenceV8,
} from "../src/e2e-evidence.js";
import {
  currentExpectedRevisions,
  manifest,
  retainedV8Evidence,
} from "./e2e-evidence-fixtures.js";

type PlaybackReceipt =
  RetainedE2eEvidenceV8["conversation"]["lifecycle"]["playbackReceipts"][number];

describe("retained addressed-answer playback receipts", () => {
  it("accepts a capture proven by matching answer started, finished and played receipts", () => {
    const evidence = evidenceWithAnswerPlaybackReceipts();

    expect(failureCodes(evidence)).not.toEqual(expect.arrayContaining([
      "ANSWER_ADMISSION_MISMATCH",
      "ANSWER_PLAYBACK_RECEIPT_MISMATCH",
    ]));
  });

  it("rejects a same-turn thinking cue even when it uses the captured attempt", () => {
    const evidence = evidenceWithAnswerPlaybackReceipts({ playbackKind: "thinking-cue" });

    expect(failureCodes(evidence)).toContain("ANSWER_PLAYBACK_RECEIPT_MISMATCH");
  });

  it("rejects a queued addressed turn", () => {
    const evidence = evidenceWithAnswerPlaybackReceipts();
    const admission = evidence.conversation.lifecycle.events.find(
      (event) => event.type === "addressed-answer",
    );
    if (admission === undefined) {
      throw new Error("addressed answer admission fixture is missing");
    }
    admission.outcome = "queued";

    expect(failureCodes(evidence)).toContain("ANSWER_ADMISSION_MISMATCH");
  });

  it("rejects receipts from a different playback attempt", () => {
    const evidence = evidenceWithAnswerPlaybackReceipts({
      playbackAttemptId: "wrong-answer-attempt",
    });

    expect(failureCodes(evidence)).toContain("ANSWER_PLAYBACK_RECEIPT_MISMATCH");
  });

  it("rejects extra answer receipts for the same turn under another attempt", () => {
    const evidence = evidenceWithAnswerPlaybackReceipts();
    evidence.conversation.lifecycle.playbackReceipts.push({
      observedAt: "1970-01-01T00:00:04.100Z",
      playbackAttemptId: "competing-answer-attempt",
      playbackKind: "answer",
      playbackStartedAtEpochMs: 4_100,
      playbackStartedAtMonotonicMs: 17,
      status: "started",
      turnId: "human-question-1",
    });
    expect(failureCodes(evidence)).toContain("ANSWER_PLAYBACK_RECEIPT_MISMATCH");
  });

  it.each([
    ["finished", (receipt: PlaybackReceipt) => receipt.status !== "finished"],
    ["played", (receipt: PlaybackReceipt) => receipt.status !== "settled"],
  ] as const)("rejects an answer without a %s receipt", (_name, retain) => {
    const evidence = evidenceWithAnswerPlaybackReceipts();
    evidence.conversation.lifecycle.playbackReceipts =
      evidence.conversation.lifecycle.playbackReceipts.filter(retain);

    expect(failureCodes(evidence)).toContain("ANSWER_PLAYBACK_RECEIPT_MISMATCH");
  });

  it("rejects answer receipts whose playback interval does not overlap the capture", () => {
    const evidence = evidenceWithAnswerPlaybackReceipts({
      finishedAtEpochMs: 3_200,
      startedAtEpochMs: 3_000,
    });

    expect(failureCodes(evidence)).toContain("ANSWER_PLAYBACK_RECEIPT_MISMATCH");
  });
});

function evidenceWithAnswerPlaybackReceipts(overrides: {
  readonly finishedAtEpochMs?: number;
  readonly playbackAttemptId?: string;
  readonly playbackKind?: "answer" | "prepared-cue" | "thinking-cue";
  readonly startedAtEpochMs?: number;
} = {}): RetainedE2eEvidenceV8 {
  const evidence = retainedV8Evidence();
  const playbackAttemptId = overrides.playbackAttemptId ?? "answer";
  const playbackKind = overrides.playbackKind ?? "answer";
  const startedAtEpochMs = overrides.startedAtEpochMs ?? 4_000;
  const finishedAtEpochMs = overrides.finishedAtEpochMs ?? 4_700;
  evidence.conversation.lifecycle.playbackReceipts = [
    {
      observedAt: "1970-01-01T00:00:04.000Z",
      playbackAttemptId,
      playbackKind,
      playbackStartedAtEpochMs: startedAtEpochMs,
      playbackStartedAtMonotonicMs: startedAtEpochMs,
      status: "started",
      turnId: "human-question-1",
    },
    {
      observedAt: "1970-01-01T00:00:04.700Z",
      playbackAttemptId,
      playbackFinishedAtEpochMs: finishedAtEpochMs,
      playbackFinishedAtMonotonicMs: finishedAtEpochMs,
      playbackKind,
      status: "finished",
      turnId: "human-question-1",
    },
    {
      observedAt: "1970-01-01T00:00:04.800Z",
      playbackAttemptId,
      playbackKind,
      playbackSettledAtEpochMs: 4_800,
      playbackSettledAtMonotonicMs: 4_800,
      settlement: "played",
      status: "settled",
      turnId: "human-question-1",
    },
  ];
  return evidence;
}

function failureCodes(evidence: RetainedE2eEvidenceV8): readonly string[] {
  return verifyRetainedE2eEvidence(
    manifest(),
    evidence,
    currentExpectedRevisions,
  ).failures.map(({ code }) => code);
}
