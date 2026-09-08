import { AppendLiveTranscriptTurn, FinishLiveMeeting, RefreshLiveMeeting, StartLiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { PlatformLiveMeetingRuntime } from "../src/live-meeting-runtime.js";
import { LiveTranscriptionAcceptanceUnknown, LiveTranscriptionTerminalFailure } from "../src/live-runtime/contracts.js";
import { logger, MemoryLiveMeetingRepository, packets, ProjectionStub, started, SummaryStub } from "./live-runtime/live-runtime-fixtures.js";
import {
  type SummaryPublicationPort,
  type SummaryPublicationRequest,
} from "@discord-meeting/meeting-core/publishing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveFencedSummaryPublicationPort } from "../src/application/live-fenced-summary-publication.js";

const request: SummaryPublicationRequest = {
  idempotencyKey: "publication-1",
  meetingId: "meeting-1",
  publicationTargetId: "1533228891827736657",
  summary: {
    actionItems: [],
    decisions: [{ decisionId: "decision-1", evidenceTurnIds: ["batch-turn-1"], text: "Ship on Friday." }],
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
    turns: [{ turnId: "batch-turn-1", speakerId: "speaker-1", startMs: 0, endMs: 1000, text: "Ship on Friday." }],
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
      publish: vi.fn(async (_request: SummaryPublicationRequest) => result),
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


afterEach(() => vi.useRealTimers());

it.each(["terminal send", "unknown send", "terminal finalize", "cancel pending send"] as const)(
  "publishes authoritative transcript and summary after quiescent degraded live ownership: %s", async (mode) => {
    vi.useFakeTimers(); vi.setSystemTime("2026-08-02T10:00:00.000Z");
    const meetings = new MemoryLiveMeetingRepository();
    const finishMeeting = new FinishLiveMeeting(meetings);
    const finish = vi.spyOn(finishMeeting, "execute");
    const warn = vi.fn<typeof logger.warn>();
    const pending = Promise.withResolvers<"accepted">();
    const delivered = vi.fn(async () => {});
    const sendPacket = vi.fn(async () => {
      if (mode === "cancel pending send") { return pending.promise; }
      if (mode === "terminal finalize") { return "accepted" as const; }
      throw mode === "unknown send" ? new LiveTranscriptionAcceptanceUnknown() : new LiveTranscriptionTerminalFailure();
    });
    const finalize = vi.fn(async () => { throw new LiveTranscriptionTerminalFailure(); });
    const terminate = vi.fn();
    const openSession = vi.fn(async () => ({ sendPacket, finalize, terminate }));
    const runtime = new PlatformLiveMeetingRuntime({
      appendTurn: new AppendLiveTranscriptTurn(meetings), finishMeeting, logger: { ...logger, warn },
      refreshMeeting: new RefreshLiveMeeting({ meetings, projector: new ProjectionStub(), summarizer: new SummaryStub() }),
      startMeeting: new StartLiveMeeting({ meetings }), transcriber: { openSession },
      markLivePacketDelivered: delivered, speakerIdleFinalizeMs: 100,
      packetInspector: { durationSamples48Khz: () => 960 },
    });
    await runtime.acceptLifecycle(started(request.meetingId));
    const batch = packets(request.meetingId);
    batch.packets[0] = { ...batch.packets[0]!, relativeTimeMs: 0 };
    await runtime.acceptVoiceBatch(batch); await vi.advanceTimersByTimeAsync(100);
    const result = { ok: true, value: { externalPublicationId: "discord:authoritative-final" } } as const;
    const delegate = { publish: vi.fn(async (_request: SummaryPublicationRequest) => result) } satisfies SummaryPublicationPort;
    const subject = new LiveFencedSummaryPublicationPort(delegate, runtime, meetings);
    const originalRequest = structuredClone(request);
    if (mode === "cancel pending send") {
      const cancellation = new AbortController();
      cancellation.abort();
      await expect(runtime.close(cancellation.signal)).rejects.toBeInstanceOf(AggregateError);
      await expect(subject.publish(request)).rejects.toBeInstanceOf(AggregateError);
      expect(delegate.publish).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
      pending.reject(new LiveTranscriptionTerminalFailure());
      await vi.advanceTimersByTimeAsync(0);
    }
    await expect(subject.publish(request)).resolves.toEqual(result);
    expect(delegate.publish).toHaveBeenCalledTimes(1);
    expect(delegate.publish.mock.calls[0]?.[0]).toMatchObject({
      transcript: originalRequest.transcript, summary: originalRequest.summary,
    });
    expect(request).toEqual(originalRequest);
    expect(request.transcript.recordingId).toBe("recording-1");
    expect(meetings.snapshot?.status).toBe("ended");
    expect(meetings.finalizedTurns).toEqual([]);
    expect(finish).toHaveBeenCalledTimes(1);
    await runtime.settleBeforeFinalPublication(request.meetingId);
    await runtime.acceptVoiceBatch(batch);
    // close() retains its original shutdown failure; the publication barrier retries settlement.
    if (mode === "cancel pending send") { await expect(runtime.close()).rejects.toBeInstanceOf(AggregateError); }
    else { await runtime.close(); }
    expect(openSession).toHaveBeenCalledTimes(1); expect(sendPacket).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveBeenCalledTimes(mode === "terminal finalize" ? 1 : 0);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some(call => call[1]?.errorCode ===
      (mode === "unknown send" ? "LIVE_TRANSCRIPTION_ACCEPTANCE_UNKNOWN" : "LIVE_TRANSCRIPTION_PROVIDER_TERMINAL"))).toBe(true);
  },
);
