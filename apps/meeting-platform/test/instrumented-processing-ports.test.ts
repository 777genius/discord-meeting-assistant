import {
  type FinalTranscriptionPort,
} from "@discord-meeting/meeting-core/transcription";
import {
  type SummaryGenerationPort,
} from "@discord-meeting/meeting-core/meeting-intelligence";
import {
  type SummaryPublicationPort,
} from "@discord-meeting/meeting-core/publishing";
import type {
  Logger,
  ProcessingStageMetrics,
} from "@discord-meeting/observability-adapter";
import { describe, expect, it, vi } from "vitest";

import {
  InstrumentedFinalTranscriptionPort,
  InstrumentedSummaryGenerationPort,
  InstrumentedSummaryPublicationPort,
} from "../src/adapters/outbound/instrumented-processing-ports.js";

function observability() {
  const metrics = {
    observeStage: vi.fn(),
  } satisfies ProcessingStageMetrics;
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
  it("records the successful final-transcription evidence profile without changing the result", async () => {
    const { logger, metrics } = observability();
    const signal = new AbortController().signal;
    const result = {
      ok: true,
      value: {
        transcriptId: "transcript-1",
        turns: [
          {
            endMs: 1_000,
            speakerId: "speaker-1",
            startMs: 0,
            text: "alpha",
            turnId: "turn-1",
          },
          {
            endMs: 4_000,
            speakerId: "speaker-2",
            startMs: 2_000,
            text: "bravo",
            turnId: "turn-2",
          },
          {
            endMs: 7_000,
            speakerId: "speaker-1",
            startMs: 5_000,
            text: "charlie",
            turnId: "turn-3",
          },
        ],
        version: 1,
      },
    } as const;
    const delegate = {
      transcribe: vi.fn(async () => result),
    } satisfies FinalTranscriptionPort;
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(4_500);
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
        speakerAudio: [
          {
            audioLocator: "s3://recordings/speaker-1.ogg",
            speakerId: "speaker-1",
            timelineOffsetMs: 0,
          },
          {
            audioLocator: "s3://recordings/speaker-2.ogg",
            speakerId: "speaker-2",
            timelineOffsetMs: 0,
          },
        ],
        version: 1,
      },
      signal,
    } as const;

    await expect(subject.transcribe(request)).resolves.toEqual(result);
    expect(delegate.transcribe).toHaveBeenCalledWith(request);
    expect(metrics.observeStage).toHaveBeenCalledWith(
      "transcription",
      "succeeded",
      3.5,
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Meeting processing stage completed",
      {
        durationMilliseconds: 3_500,
        evidenceCharacterCount: 17,
        evidenceSpeakerCount: 2,
        evidenceSpeechSpanMs: 7_000,
        evidenceTimelineEndMs: 7_000,
        evidenceTimelineStartMs: 0,
        evidenceTurnCount: 3,
        meetingId: "meeting-1",
        outcome: "succeeded",
        processingToEvidenceRatio: 0.5,
        speakerTrackCount: 2,
        stage: "transcription",
      },
    );
    expect(now).toHaveBeenCalledTimes(2);
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
    expect(logger.info).toHaveBeenCalledWith(
      "Meeting processing stage completed",
      {
        durationMilliseconds: 125,
        evidenceCharacterCount: 0,
        evidenceSpeakerCount: 0,
        evidenceTurnCount: 0,
        failureCode: "INVALID",
        meetingId: "meeting-1",
        outcome: "terminal-failure",
        retryable: false,
        stage: "summary",
      },
    );
  });
});

describe("instrumented processing failure evidence", () => {
  it("records final-transcription failures with request track count and no result content", async () => {
    const { logger, metrics } = observability();
    const result = {
      failure: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "provider failed",
        retryable: true,
      },
      ok: false,
    } as const;
    const delegate = {
      transcribe: vi.fn(async () => result),
    } satisfies FinalTranscriptionPort;
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_075);
    const subject = new InstrumentedFinalTranscriptionPort(
      delegate,
      metrics,
      logger,
      now,
    );

    await expect(subject.transcribe({
      idempotencyKey: "transcription-2",
      meetingId: "meeting-2",
      recording: {
        manifestLocator: "s3://recordings/manifest.json",
        recordingId: "recording-2",
        speakerAudio: [{
          audioLocator: "s3://recordings/speaker-1.ogg",
          speakerId: "speaker-1",
          timelineOffsetMs: 0,
        }],
      },
    })).resolves.toEqual(result);

    expect(logger.info).toHaveBeenCalledWith(
      "Meeting processing stage completed",
      {
        durationMilliseconds: 75,
        failureCode: "UPSTREAM_UNAVAILABLE",
        meetingId: "meeting-2",
        outcome: "retryable-failure",
        retryable: true,
        speakerTrackCount: 1,
        stage: "transcription",
      },
    );
  });

  it("omits the processing ratio when final evidence has no timeline span", async () => {
    const { logger, metrics } = observability();
    const result = {
      ok: true,
      value: { transcriptId: "transcript-3", turns: [], version: 1 },
    } as const;
    const delegate = {
      transcribe: vi.fn(async () => result),
    } satisfies FinalTranscriptionPort;
    const subject = new InstrumentedFinalTranscriptionPort(
      delegate,
      metrics,
      logger,
      () => 1_000,
    );

    await expect(subject.transcribe({
      idempotencyKey: "transcription-3",
      meetingId: "meeting-3",
      recording: {
        manifestLocator: "s3://recordings/manifest.json",
        recordingId: "recording-3",
        speakerAudio: [],
      },
    })).resolves.toEqual(result);

    const fields = logger.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields).toMatchObject({
      evidenceCharacterCount: 0,
      evidenceSpeakerCount: 0,
      evidenceTurnCount: 0,
      speakerTrackCount: 0,
    });
    expect(fields).not.toHaveProperty("processingToEvidenceRatio");
  });

  it("records final-summary evidence and result counts without summary content", async () => {
    const { logger, metrics } = observability();
    const result = {
      ok: true,
      value: {
        actionItems: [],
        decisions: [],
        openQuestions: [],
        overview: "summary text is never logged",
        summaryId: "summary-1",
        title: "Summary",
        topics: [],
        version: 1,
      },
    } as const;
    const delegate = {
      generate: vi.fn(async () => result),
    } satisfies SummaryGenerationPort;
    const now = vi.fn()
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_050);
    const subject = new InstrumentedSummaryGenerationPort(
      delegate,
      metrics,
      logger,
      now,
    );

    await expect(subject.generate({
      idempotencyKey: "summary-2",
      meetingId: "meeting-2",
      transcript: {
        recordingId: "recording-2",
        transcriptId: "transcript-2",
        turns: [{
          endMs: 6_000,
          speakerId: "speaker-1",
          startMs: 1_000,
          text: "evidence only",
          turnId: "turn-1",
        }],
        version: 1,
      },
    })).resolves.toEqual(result);

    expect(logger.info).toHaveBeenCalledWith(
      "Meeting processing stage completed",
      {
        durationMilliseconds: 50,
        evidenceCharacterCount: 13,
        evidenceSpeakerCount: 1,
        evidenceSpeechSpanMs: 5_000,
        evidenceTimelineEndMs: 6_000,
        evidenceTimelineStartMs: 1_000,
        evidenceTurnCount: 1,
        meetingId: "meeting-2",
        outcome: "succeeded",
        stage: "summary",
        summaryActionCount: 0,
        summaryDecisionCount: 0,
        summaryQuestionCount: 0,
        summaryTopicCount: 0,
      },
    );
  });

  it("records an unexpected publication exception as retryable and rethrows it", async () => {
    const { logger, metrics } = observability();
    const error = new Error("network failed");
    error.name = "Bearer secret";
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
    expect(logger.info).toHaveBeenCalledWith(
      "Meeting processing stage completed",
      {
        durationMilliseconds: 500,
        errorName: "Error",
        meetingId: "meeting-1",
        outcome: "retryable-failure",
        stage: "publication",
      },
    );
  });
});
