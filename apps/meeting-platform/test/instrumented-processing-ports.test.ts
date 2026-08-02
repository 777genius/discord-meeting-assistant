import type {
  FinalTranscriptionPort,
  SummaryGenerationPort,
  SummaryPublicationPort,
} from "@discord-meeting/meeting-core";
import type { Logger, Metrics } from "@discord-meeting/observability-adapter";
import { describe, expect, it, vi } from "vitest";

import {
  InstrumentedFinalTranscriptionPort,
  InstrumentedSummaryGenerationPort,
  InstrumentedSummaryPublicationPort,
} from "../src/instrumented-processing-ports.js";

function observability() {
  const metrics = {
    observeStage: vi.fn(),
    recordDeadLetter: vi.fn(),
    recordDiscordPublication: vi.fn(),
    recordIngress: vi.fn(),
    recordQueueRetry: vi.fn(),
    setProviderHealth: vi.fn(),
    setQueueState: vi.fn(),
  } satisfies Metrics;
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => {}),
    info: vi.fn(),
    warn: vi.fn(),
  } satisfies Logger;
  return { logger, metrics };
}

describe("instrumented processing ports", () => {
  it("records successful final transcription duration without changing the result", async () => {
    const { logger, metrics } = observability();
    const result = {
      ok: true,
      value: { transcriptId: "transcript-1", turns: [], version: 1 },
    } as const;
    const delegate = {
      transcribe: vi.fn(async () => result),
    } satisfies FinalTranscriptionPort;
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(3_250);
    const subject = new InstrumentedFinalTranscriptionPort(
      delegate,
      metrics,
      logger,
      now,
    );
    const request = {
      idempotencyKey: "transcription-1",
      meetingId: "meeting-1",
      recording: {
        finalizedAt: "2026-08-02T00:00:00.000Z",
        manifestLocator: "s3://recordings/manifest.json",
        recordingId: "recording-1",
        source: "craig-original",
        speakerAudio: [{
          audioLocator: "s3://recordings/speaker-1.ogg",
          speakerId: "speaker-1",
          timelineOffsetMs: 0,
        }],
        version: 1,
      },
    } as const;

    await expect(subject.transcribe(request)).resolves.toEqual(result);
    expect(metrics.observeStage).toHaveBeenCalledWith(
      "transcription",
      "succeeded",
      2.25,
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Meeting processing stage completed",
      {
        durationMilliseconds: 2_250,
        meetingId: "meeting-1",
        outcome: "succeeded",
        stage: "transcription",
      },
    );
  });

  it("records the port failure classification for summary generation", async () => {
    const { logger, metrics } = observability();
    const delegate = {
      generate: vi.fn(async () => ({
        failure: { code: "INVALID", message: "invalid", retryable: false },
        ok: false,
      } as const)),
    } satisfies SummaryGenerationPort;
    const now = vi.fn()
      .mockReturnValueOnce(5_000)
      .mockReturnValueOnce(5_125);
    const subject = new InstrumentedSummaryGenerationPort(
      delegate,
      metrics,
      logger,
      now,
    );

    const result = await subject.generate({
      idempotencyKey: "summary-1",
      meetingId: "meeting-1",
      transcript: {
        recordingId: "recording-1",
        transcriptId: "transcript-1",
        turns: [],
        version: 1,
      },
    });

    expect(result.ok).toBe(false);
    expect(metrics.observeStage).toHaveBeenCalledWith(
      "summary",
      "terminal-failure",
      0.125,
    );
  });

  it("records an unexpected publication exception as retryable and rethrows it", async () => {
    const { logger, metrics } = observability();
    const error = new Error("network failed");
    const delegate = {
      publish: vi.fn(async () => Promise.reject(error)),
    } satisfies SummaryPublicationPort;
    const now = vi.fn()
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_500);
    const subject = new InstrumentedSummaryPublicationPort(
      delegate,
      metrics,
      logger,
      now,
    );

    await expect(subject.publish({
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
    })).rejects.toBe(error);
    expect(metrics.observeStage).toHaveBeenCalledWith(
      "publication",
      "retryable-failure",
      0.5,
    );
  });
});
