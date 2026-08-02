import { describe, expect, it } from "vitest";

import {
  EvidenceBackedSummary,
  FinalTranscript,
  Meeting,
  ProcessMeetingSummary,
  type FinalTranscriptionPort,
  type FinalTranscriptionRequest,
  type GeneratedSummary,
  type GeneratedTranscript,
  type MeetingRepository,
  type MeetingSnapshot,
  type PortResult,
  type SummaryGenerationPort,
  type SummaryGenerationRequest,
  type SummaryPublicationPort,
  type SummaryPublicationRequest,
} from "../src/index.js";

const recording = {
  manifestLocator: "recordings/recording-1/manifest.json",
  recordingId: "recording-1",
  speakerAudio: [
    {
      audioLocator: "recordings/recording-1/speaker-a.flac",
      speakerId: "speaker-a",
      timelineOffsetMs: 0,
    },
    {
      audioLocator: "recordings/recording-1/speaker-b.flac",
      speakerId: "speaker-b",
      timelineOffsetMs: 900,
    },
  ],
} as const;

const generatedTranscript: GeneratedTranscript = {
  transcriptId: "transcript-1",
  turns: [
    {
      endMs: 1_500,
      speakerId: "speaker-a",
      startMs: 0,
      text: "Ship on Friday.",
      turnId: "turn-1",
    },
    {
      endMs: 2_100,
      speakerId: "speaker-b",
      startMs: 900,
      text: "I will prepare the release checklist.",
      turnId: "turn-2",
    },
  ],
  version: 1,
};

const generatedSummary: GeneratedSummary = {
  actionItems: [
    {
      actionItemId: "action-1",
      deadline: null,
      evidenceTurnIds: ["turn-2"],
      ownerSpeakerId: "speaker-b",
      text: "Prepare the release checklist.",
    },
  ],
  decisions: [
    {
      decisionId: "decision-1",
      evidenceTurnIds: ["turn-1"],
      text: "Ship on Friday.",
    },
  ],
  openQuestions: [
    {
      evidenceTurnIds: ["turn-2"],
      id: "question-1",
      text: "Who will verify the deployment?",
    },
  ],
  overview: "The team planned the first release.",
  summaryId: "summary-1",
  title: "Release planning",
  topics: [
    {
      evidenceTurnIds: ["turn-1", "turn-2"],
      points: ["Friday release", "Checklist ownership"],
      title: "Release readiness",
    },
  ],
  version: 1,
};

function initialSnapshot(): MeetingSnapshot {
  return Meeting.record({
    meetingId: "meeting-1",
    publicationTargetId: "results-channel",
    recording,
  }).toSnapshot();
}

class MemoryMeetingRepository implements MeetingRepository {
  public snapshot: MeetingSnapshot;
  public readonly saved: MeetingSnapshot[] = [];

  public constructor(snapshot: MeetingSnapshot) {
    this.snapshot = structuredClone(snapshot);
  }

  public findById(meetingId: string): Promise<MeetingSnapshot | null> {
    return Promise.resolve(
      this.snapshot.meetingId === meetingId ? structuredClone(this.snapshot) : null,
    );
  }

  public save(snapshot: MeetingSnapshot, expectedRevision: number): Promise<void> {
    if (this.snapshot.revision !== expectedRevision) {
      throw new Error(
        `revision conflict: expected ${expectedRevision}, actual ${this.snapshot.revision}`,
      );
    }
    this.snapshot = structuredClone(snapshot);
    this.saved.push(structuredClone(snapshot));
    return Promise.resolve();
  }
}

type TranscriptionStep = Error | PortResult<GeneratedTranscript>;

class SequenceTranscriber implements FinalTranscriptionPort {
  public readonly requests: FinalTranscriptionRequest[] = [];

  public constructor(private readonly steps: TranscriptionStep[]) {}

  public transcribe(
    request: FinalTranscriptionRequest,
  ): Promise<PortResult<GeneratedTranscript>> {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error("unexpected transcription call");
    }
    if (step instanceof Error) {
      throw step;
    }
    return Promise.resolve(step);
  }
}

type SummaryStep = Error | PortResult<GeneratedSummary>;

class SequenceSummarizer implements SummaryGenerationPort {
  public readonly requests: SummaryGenerationRequest[] = [];

  public constructor(private readonly steps: SummaryStep[]) {}

  public generate(
    request: SummaryGenerationRequest,
  ): Promise<PortResult<GeneratedSummary>> {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error("unexpected summary call");
    }
    if (step instanceof Error) {
      throw step;
    }
    return Promise.resolve(step);
  }
}

type PublicationValue = { readonly externalPublicationId: string };
type PublicationStep = Error | PortResult<PublicationValue>;

class SequencePublisher implements SummaryPublicationPort {
  public readonly requests: SummaryPublicationRequest[] = [];

  public constructor(private readonly steps: PublicationStep[]) {}

  public publish(
    request: SummaryPublicationRequest,
  ): Promise<PortResult<PublicationValue>> {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error("unexpected publication call");
    }
    if (step instanceof Error) {
      throw step;
    }
    return Promise.resolve(step);
  }
}

function success<Value>(value: Value): PortResult<Value> {
  return { ok: true, value };
}

function retryableFailure(code: string): PortResult<never> {
  return {
    failure: { code, message: "temporary failure", retryable: true },
    ok: false,
  };
}

describe("ProcessMeetingSummary", () => {
  it("runs the summary-first flow once and reuses the completed publication", async () => {
    const meetings = new MemoryMeetingRepository(initialSnapshot());
    const transcriber = new SequenceTranscriber([success(generatedTranscript)]);
    const summarizer = new SequenceSummarizer([success(generatedSummary)]);
    const publisher = new SequencePublisher([
      success({ externalPublicationId: "thread-1" }),
    ]);
    const useCase = new ProcessMeetingSummary({
      meetings,
      publisher,
      summarizer,
      transcriber,
    });

    await expect(useCase.execute("meeting-1")).resolves.toMatchObject({
      externalPublicationId: "thread-1",
      reused: false,
      status: "published",
    });
    await expect(useCase.execute("meeting-1")).resolves.toMatchObject({
      externalPublicationId: "thread-1",
      reused: true,
      status: "published",
    });

    expect(transcriber.requests).toHaveLength(1);
    expect(summarizer.requests).toHaveLength(1);
    expect(summarizer.requests[0]?.idempotencyKey).toContain(
      "evidence-summary:v3",
    );
    expect(summarizer.requests[0]?.idempotencyKey).not.toContain(
      "evidence-summary:v2",
    );
    expect(publisher.requests).toHaveLength(1);
    expect(meetings.snapshot.recording).toEqual(recording);
  });

  it("preserves recording and transcript when summary fails, then retries only summary", async () => {
    const meetings = new MemoryMeetingRepository(initialSnapshot());
    const transcriber = new SequenceTranscriber([success(generatedTranscript)]);
    const summarizer = new SequenceSummarizer([
      retryableFailure("LLM_RATE_LIMITED"),
      success(generatedSummary),
    ]);
    const publisher = new SequencePublisher([
      success({ externalPublicationId: "thread-1" }),
    ]);
    const useCase = new ProcessMeetingSummary({
      meetings,
      publisher,
      summarizer,
      transcriber,
    });

    await expect(useCase.execute("meeting-1")).resolves.toMatchObject({
      stage: "summary",
      status: "failed",
    });
    expect(meetings.snapshot.recording).toEqual(recording);
    expect(meetings.snapshot.transcript).not.toBeNull();
    expect(meetings.snapshot.transcriptionStage.status).toBe("succeeded");

    await expect(useCase.execute("meeting-1")).resolves.toMatchObject({
      status: "published",
    });
    expect(transcriber.requests).toHaveLength(1);
    expect(summarizer.requests).toHaveLength(2);
    expect(summarizer.requests[0]?.idempotencyKey).toBe(
      summarizer.requests[1]?.idempotencyKey,
    );
  });

  it("reuses publication identity after an unknown external outcome", async () => {
    const meetings = new MemoryMeetingRepository(initialSnapshot());
    const transcriber = new SequenceTranscriber([success(generatedTranscript)]);
    const summarizer = new SequenceSummarizer([success(generatedSummary)]);
    const publisher = new SequencePublisher([
      new Error("connection lost after send"),
      success({ externalPublicationId: "thread-reconciled" }),
    ]);
    const useCase = new ProcessMeetingSummary({
      meetings,
      publisher,
      summarizer,
      transcriber,
    });

    await expect(useCase.execute("meeting-1")).resolves.toMatchObject({
      failure: { retryable: true },
      stage: "publication",
      status: "failed",
    });
    await expect(useCase.execute("meeting-1")).resolves.toMatchObject({
      externalPublicationId: "thread-reconciled",
      status: "published",
    });

    expect(publisher.requests).toHaveLength(2);
    expect(publisher.requests[0]?.idempotencyKey).toBe(
      publisher.requests[1]?.idempotencyKey,
    );
    expect(transcriber.requests).toHaveLength(1);
    expect(summarizer.requests).toHaveLength(1);
  });

  it("reconciles a publication left running after a worker crash", async () => {
    const meeting = Meeting.restore(initialSnapshot());
    const transcript = FinalTranscript.create({
      ...generatedTranscript,
      recordingId: recording.recordingId,
    });
    meeting.beginTranscription();
    meeting.completeTranscription(transcript);
    meeting.beginSummary();
    meeting.completeSummary(
      EvidenceBackedSummary.create(
        {
          ...generatedSummary,
          transcriptId: transcript.transcriptId,
        },
        transcript,
      ),
    );
    meeting.beginPublication();
    const expectedKey = meeting.publicationIdempotencyKey();

    const meetings = new MemoryMeetingRepository(meeting.toSnapshot());
    const publisher = new SequencePublisher([
      success({ externalPublicationId: "thread-reconciled" }),
    ]);
    const useCase = new ProcessMeetingSummary({
      meetings,
      publisher,
      summarizer: new SequenceSummarizer([]),
      transcriber: new SequenceTranscriber([]),
    });

    await expect(useCase.execute("meeting-1")).resolves.toMatchObject({
      externalPublicationId: "thread-reconciled",
      status: "published",
    });
    expect(publisher.requests[0]?.idempotencyKey).toBe(expectedKey);
    expect(meetings.snapshot.publicationStage).toMatchObject({
      attempts: 1,
      status: "succeeded",
    });
  });

  it("rejects invalid summary evidence as terminal and never calls publishing", async () => {
    const meetings = new MemoryMeetingRepository(initialSnapshot());
    const transcriber = new SequenceTranscriber([success(generatedTranscript)]);
    const summarizer = new SequenceSummarizer([
      success({
        ...generatedSummary,
        decisions: [
          {
            decisionId: "decision-1",
            evidenceTurnIds: ["hallucinated-turn"],
            text: "Unsupported decision.",
          },
        ],
      }),
    ]);
    const publisher = new SequencePublisher([]);
    const useCase = new ProcessMeetingSummary({
      meetings,
      publisher,
      summarizer,
      transcriber,
    });

    await expect(useCase.execute("meeting-1")).resolves.toMatchObject({
      failure: { code: "INVALID_SUMMARY_OUTPUT", retryable: false },
      stage: "summary",
      status: "failed",
    });
    await expect(useCase.execute("meeting-1")).resolves.toMatchObject({
      failure: { code: "INVALID_SUMMARY_OUTPUT", retryable: false },
      stage: "summary",
      status: "failed",
    });

    expect(summarizer.requests).toHaveLength(1);
    expect(publisher.requests).toHaveLength(0);
    expect(meetings.snapshot.recording).toEqual(recording);
    expect(meetings.snapshot.transcript).not.toBeNull();
  });

  it("rejects unsupported open questions before publication", async () => {
    const meetings = new MemoryMeetingRepository(initialSnapshot());
    const transcriber = new SequenceTranscriber([success(generatedTranscript)]);
    const summarizer = new SequenceSummarizer([
      success({
        ...generatedSummary,
        openQuestions: [
          {
            evidenceTurnIds: ["hallucinated-turn"],
            id: "question-unsupported",
            text: "Is an unsupported requirement approved?",
          },
        ],
      }),
    ]);
    const publisher = new SequencePublisher([]);
    const useCase = new ProcessMeetingSummary({
      meetings,
      publisher,
      summarizer,
      transcriber,
    });

    await expect(useCase.execute("meeting-1")).resolves.toMatchObject({
      failure: { code: "INVALID_SUMMARY_OUTPUT", retryable: false },
      stage: "summary",
      status: "failed",
    });
    expect(publisher.requests).toHaveLength(0);
  });

  it("retries a classified transcription failure with the same operation identity", async () => {
    const meetings = new MemoryMeetingRepository(initialSnapshot());
    const transcriber = new SequenceTranscriber([
      retryableFailure("STT_UNAVAILABLE"),
      success(generatedTranscript),
    ]);
    const summarizer = new SequenceSummarizer([success(generatedSummary)]);
    const publisher = new SequencePublisher([
      success({ externalPublicationId: "thread-1" }),
    ]);
    const useCase = new ProcessMeetingSummary({
      meetings,
      publisher,
      summarizer,
      transcriber,
    });

    await expect(useCase.execute("meeting-1")).resolves.toMatchObject({
      stage: "transcription",
      status: "failed",
    });
    await expect(useCase.execute("meeting-1")).resolves.toMatchObject({
      status: "published",
    });

    expect(transcriber.requests).toHaveLength(2);
    expect(transcriber.requests[0]?.idempotencyKey).toBe(
      transcriber.requests[1]?.idempotencyKey,
    );
    expect(meetings.snapshot.transcriptionStage).toMatchObject({
      attempts: 2,
      status: "succeeded",
    });
  });
});
