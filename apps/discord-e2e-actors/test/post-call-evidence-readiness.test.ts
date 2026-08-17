import { describe, expect, it, vi } from "vitest";

import type { DatabaseObservation } from "../src/e2e-retained-evidence-contracts.js";
import { awaitTerminalPostCallEvidence } from "../src/post-call-evidence-readiness.js";

type Status = "failed" | "pending" | "running" | "succeeded";

function observation(overrides: {
  readonly publication?: Status;
  readonly recordingId?: string;
  readonly summary?: Status;
  readonly transcription?: Status;
} = {}): DatabaseObservation {
  const transcription = overrides.transcription ?? "succeeded";
  const summary = overrides.summary ?? "succeeded";
  const publication = overrides.publication ?? "succeeded";
  return {
    matchingMeetingCount: 1,
    matchingRecordingCount: 1,
    matchingSummaryCount: summary === "succeeded" ? 1 : 0,
    matchingTranscriptCount: transcription === "succeeded" ? 1 : 0,
    snapshot: {
      meetingId: "recording-1",
      publicationStage: stage(publication),
      recording: { recordingId: overrides.recordingId ?? "recording-1" },
      summaryStage: stage(summary),
      transcriptionStage: stage(transcription),
    },
  };
}

function stage(status: Status) {
  if (status === "pending") {
    return { attempts: 0, status };
  }
  if (status === "failed") {
    return {
      attempts: 1,
      failure: { code: "PROVIDER_BUSY", message: "retry later", retryable: true },
      status,
    };
  }
  return { attempts: 1, status };
}

describe("awaitTerminalPostCallEvidence", () => {
  it("returns a terminal observation without waiting", async () => {
    const collect = vi.fn(async () => observation());
    const wait = vi.fn(async () => {});

    await expect(awaitTerminalPostCallEvidence(collect, "recording-1", {
      maximumAttempts: 2,
      retryDelayMilliseconds: 1,
      wait,
    })).resolves.toEqual(observation());

    expect(collect).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("polls pending processing and returns only after publication succeeds", async () => {
    const snapshots = [
      observation({ publication: "pending", summary: "running" }),
      observation({ publication: "running" }),
      observation(),
    ];
    const collect = vi.fn(async () => snapshots.shift()!);
    const wait = vi.fn(async () => {});

    await expect(awaitTerminalPostCallEvidence(collect, "recording-1", {
      maximumAttempts: 3,
      retryDelayMilliseconds: 7,
      wait,
    })).resolves.toEqual(observation());

    expect(collect).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 7);
  });

  it("allows a retryable failed stage to recover", async () => {
    const snapshots = [
      observation({ publication: "pending", summary: "failed" }),
      observation(),
    ];

    await expect(awaitTerminalPostCallEvidence(
      async () => snapshots.shift()!,
      "recording-1",
      { maximumAttempts: 2, retryDelayMilliseconds: 1, wait: async () => {} },
    )).resolves.toEqual(observation());
  });

  it("fails immediately for a non-retryable stage failure", async () => {
    const value = observation({ publication: "failed" });
    const snapshot = value.snapshot as {
      publicationStage: {
        failure: { code: string; message: string; retryable: boolean };
      };
    };
    snapshot.publicationStage.failure = {
      code: "INVALID_PUBLICATION_OUTPUT",
      message: "invalid",
      retryable: false,
    };
    const collect = vi.fn(async () => value);
    const wait = vi.fn(async () => {});

    await expect(awaitTerminalPostCallEvidence(collect, "recording-1", {
      maximumAttempts: 2,
      retryDelayMilliseconds: 1,
      wait,
    })).rejects.toThrow("Post-call publication failed terminally: INVALID_PUBLICATION_OUTPUT");

    expect(collect).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("fails closed on ambiguous or mismatched identities", async () => {
    await expect(awaitTerminalPostCallEvidence(
      async () => ({ ...observation(), matchingRecordingCount: 2 }),
      "recording-1",
      { maximumAttempts: 1, retryDelayMilliseconds: 1 },
    )).rejects.toThrow("one unambiguous meeting and recording");

    await expect(awaitTerminalPostCallEvidence(
      async () => observation({ recordingId: "recording-2" }),
      "recording-1",
      { maximumAttempts: 1, retryDelayMilliseconds: 1 },
    )).rejects.toThrow("different recording");
  });

  it("fails after the bounded window without an extra wait", async () => {
    const collect = vi.fn(async () =>
      observation({ publication: "pending", summary: "running" })
    );
    const wait = vi.fn(async () => {});

    await expect(awaitTerminalPostCallEvidence(collect, "recording-1", {
      maximumAttempts: 3,
      retryDelayMilliseconds: 1,
      wait,
    })).rejects.toThrow("bounded readiness window");

    expect(collect).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("rejects impossible stage ordering instead of retrying malformed state", async () => {
    await expect(awaitTerminalPostCallEvidence(
      async () => observation({
        publication: "pending",
        summary: "running",
        transcription: "running",
      }),
      "recording-1",
      { maximumAttempts: 2, retryDelayMilliseconds: 1, wait: async () => {} },
    )).rejects.toThrow("summary before successful transcription");
  });
});
