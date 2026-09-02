import { describe, expect, it } from "vitest";

import { TranscriptOutlineSummaryAdapter } from "../src/adapters/outbound/transcript-outline-summary-adapter.js";

describe("TranscriptOutlineSummaryAdapter", () => {
  it("returns a stable evidence-safe outline without inferred claims", async () => {
    const adapter = new TranscriptOutlineSummaryAdapter();
    const request = {
      idempotencyKey: "meeting-1:v1",
      meetingId: "meeting-1",
      transcript: {
        recordingId: "recording-1",
        transcriptId: "transcript-1",
        turns: [{
          endMs: 2_000,
          speakerId: "speaker-1",
          startMs: 1_000,
          text: "Synthetic fixture only.",
          turnId: "turn-1",
        }],
        version: 1,
      },
    } as const;

    const first = await adapter.generate(request);
    const second = await adapter.generate(request);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      value: {
        actionItems: [],
        decisions: [],
        openQuestions: [],
        overview: "Authoritative transcript finalized with 1 turn. See the attached transcript for complete evidence.",
        title: "Meeting transcript",
        topics: [],
      },
    });
    expect(await adapter.checkHealth()).toEqual({ status: "serving" });
  });
});
