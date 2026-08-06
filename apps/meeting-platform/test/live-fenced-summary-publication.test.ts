import {
  type SummaryPublicationPort,
  type SummaryPublicationRequest,
} from "@discord-meeting/meeting-core/publishing";
import { describe, expect, it, vi } from "vitest";

import { LiveFencedSummaryPublicationPort } from "../src/application/live-fenced-summary-publication.js";

const request: SummaryPublicationRequest = {
  idempotencyKey: "publication-1",
  meetingId: "meeting-1",
  publicationTargetId: "1533228891827736657",
  summary: {
    actionItems: [],
    decisions: [],
    openQuestions: [],
    overview: "Кратко",
    summaryId: "summary-1",
    title: "Итоги",
    topics: [],
    transcriptId: "transcript-1",
    version: 1,
  },
  transcript: {
    recordingId: "recording-1",
    transcriptId: "transcript-1",
    turns: [],
    version: 1,
  },
};

describe("LiveFencedSummaryPublicationPort", () => {
  it("does not publish the final summary until live finalization releases the fence", async () => {
    let releaseBarrier: (() => void) | undefined;
    const barrierPromise = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const barrier = {
      settleBeforeFinalPublication: vi.fn(async () => barrierPromise),
    };
    const result = {
      ok: true,
      value: { externalPublicationId: "discord:final-1" },
    } as const;
    const delegate = {
      publish: vi.fn(async () => result),
    } satisfies SummaryPublicationPort;
    const liveReceipts = {
      findById: vi.fn(async () => ({
        projectionExternalId:
          "discord:v1:thread:22222222222222222:message:33333333333333333",
        publicationTargetId: "1533228891827736657",
      })),
    };
    const subject = new LiveFencedSummaryPublicationPort(delegate, barrier, liveReceipts);

    const publication = subject.publish(request);
    await Promise.resolve();
    expect(delegate.publish).not.toHaveBeenCalled();

    releaseBarrier?.();
    await expect(publication).resolves.toEqual(result);
    expect(barrier.settleBeforeFinalPublication).toHaveBeenCalledWith("meeting-1");
    expect(liveReceipts.findById).toHaveBeenCalledWith("meeting-1");
    expect(delegate.publish).toHaveBeenCalledWith({
      ...request,
      currentExternalPublicationId:
        "discord:v1:thread:22222222222222222:message:33333333333333333",
    });
  });
});
