import {
  DiscordSummaryPublicationAdapter,
  type DiscordProjectionReference,
  type PublishDiscordSummary,
} from "@discord-meeting/discord-adapter";
import type {
  SummaryGenerationPort,
  SummaryGenerationRequest,
} from "@discord-meeting/meeting-core/meeting-intelligence";
import {
  Meeting,
  type MeetingRepository,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core/meeting-lifecycle";
import { ProcessMeetingSummary } from "@discord-meeting/meeting-core/post-call-workflow";
import {
  FetchVoicetextBatchClient,
  VoicetextBatchFinalTranscriptionAdapter,
  type CompleteOggArtifactReader,
} from "@discord-meeting/voicetext-adapter";
import { describe, expect, it } from "vitest";

const jobId = "00000000-0000-4000-8000-000000000001";

describe("provider-neutral transcript segments E2E", () => {
  it("persists enriched v2 segments, renders a compact timeline, and keeps raw evidence", async () => {
    let submittedContractVersion: unknown = null;
    const client = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, async (_input, init) => {
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);
      if (!(body instanceof FormData)) {
        throw new Error("expected batch multipart body");
      }
      submittedContractVersion = body.get("contract_version");
      return Response.json(completedBatchV2Response());
    });
    const reader: CompleteOggArtifactReader = {
      read: async () => ({ bytes: validOgg(), complete: true, container: "ogg" }),
    };
    const meetings = new MemoryMeetingRepository(initialMeeting());
    const summarizer = new EvidenceOnlySummarizer();
    const projector = new CapturingDiscordProjector();
    const useCase = new ProcessMeetingSummary({
      meetings,
      publisher: new DiscordSummaryPublicationAdapter(projector),
      summarizer,
      transcriber: new VoicetextBatchFinalTranscriptionAdapter(client, reader, {}),
    });

    await expect(useCase.execute("meeting-e2e")).resolves.toMatchObject({
      reused: false,
      status: "published",
    });

    expect(submittedContractVersion).toBe("2");
    expect(meetings.snapshot.transcript).toMatchObject({
      readableSegments: [{
        endMs: 2_800,
        speakerId: "speaker-a",
        startMs: 0,
        text: "Релиз в пятницу.",
      }],
      turns: [
        { endMs: 1_250, text: "Релиз" },
        { endMs: 2_800, startMs: 1_250, text: "в пятницу" },
      ],
      version: 2,
    });
    expect(meetings.snapshot.transcript?.readableSegments?.[0]?.sourceTurnIds).toHaveLength(2);
    expect(summarizer.request?.transcript.turns).toHaveLength(2);

    const publication = projector.inputs[0];
    expect(publication).toBeDefined();
    expect(publication?.liveCaptionsMarkdown).toBeUndefined();
    expect(publication?.transcriptAttachment?.content).toContain("Релиз");
    expect(publication?.transcriptAttachment?.content).toContain("в пятницу");
    expect(publication?.transcriptAttachment?.content.match(/^## `/gmu)).toHaveLength(2);
  });

  it("falls back to all raw turns when one speaker has no readable projection", async () => {
    const client = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, async (_input, init) => {
      const body = init?.body;
      if (!(body instanceof FormData)) {
        throw new Error("expected batch multipart body");
      }
      const file = body.get("file");
      if (!(file instanceof Blob)) {
        throw new Error("expected speaker Ogg upload");
      }
      const marker = new Uint8Array(await file.arrayBuffer())[5];
      return Response.json(singleTurnBatchV2Response(marker === 1));
    });
    const reader: CompleteOggArtifactReader = {
      read: async (audioLocator) => ({
        bytes: validOgg(audioLocator.includes("speaker-a") ? 1 : 2),
        complete: true,
        container: "ogg",
      }),
    };
    const meetings = new MemoryMeetingRepository(initialTwoSpeakerMeeting());
    const projector = new CapturingDiscordProjector();
    const useCase = new ProcessMeetingSummary({
      meetings,
      publisher: new DiscordSummaryPublicationAdapter(projector),
      summarizer: new EvidenceOnlySummarizer(),
      transcriber: new VoicetextBatchFinalTranscriptionAdapter(client, reader, {}),
    });

    await expect(useCase.execute("meeting-e2e")).resolves.toMatchObject({
      status: "published",
    });

    expect(meetings.snapshot.transcript?.readableSegments).toEqual([]);
    expect(projector.inputs[0]).toBeDefined();
    expect(projector.inputs[0]?.liveCaptionsMarkdown).toBeUndefined();
    expect(projector.inputs[0]?.transcriptAttachment?.content).toContain(
      "speaker-a",
    );
    expect(projector.inputs[0]?.transcriptAttachment?.content).toContain(
      "speaker-b",
    );
  });
});

class MemoryMeetingRepository implements MeetingRepository {
  public snapshot: MeetingSnapshot;

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
      throw new Error("unexpected meeting revision");
    }
    this.snapshot = structuredClone(snapshot);
    return Promise.resolve();
  }
}

class EvidenceOnlySummarizer implements SummaryGenerationPort {
  public request: SummaryGenerationRequest | undefined;

  public generate(request: SummaryGenerationRequest) {
    this.request = structuredClone(request);
    const evidenceTurnId = request.transcript.turns[0]?.turnId;
    if (evidenceTurnId === undefined) {
      throw new Error("expected authoritative raw evidence");
    }
    return Promise.resolve({
      ok: true as const,
      value: {
        actionItems: [],
        decisions: [{
          decisionId: "decision-1",
          evidenceTurnIds: [evidenceTurnId],
          text: "Релиз состоится в пятницу.",
        }],
        openQuestions: [],
        overview: "Команда согласовала дату релиза.",
        summaryId: "summary-e2e",
        title: "План релиза",
        topics: [{
          evidenceTurnIds: [evidenceTurnId],
          points: ["Релиз в пятницу"],
          title: "Релиз",
        }],
        version: 1,
      },
    });
  }
}

class CapturingDiscordProjector {
  public readonly inputs: PublishDiscordSummary[] = [];

  public publish(input: PublishDiscordSummary): Promise<DiscordProjectionReference> {
    this.inputs.push(input);
    return Promise.resolve({
      kind: "thread",
      messageId: "33333333333333333",
      threadId: "22222222222222222",
    });
  }
}

function initialMeeting(): MeetingSnapshot {
  return Meeting.record({
    meetingId: "meeting-e2e",
    publicationTargetId: "11111111111111111",
    recording: {
      manifestLocator: "recordings/recording-e2e/manifest.json",
      recordingId: "recording-e2e",
      speakerAudio: [{
        audioLocator: "recordings/recording-e2e/speaker-a.ogg",
        speakerId: "speaker-a",
        timelineOffsetMs: 0,
      }],
    },
  }).toSnapshot();
}

function initialTwoSpeakerMeeting(): MeetingSnapshot {
  const snapshot = initialMeeting();
  return Meeting.record({
    meetingId: snapshot.meetingId,
    publicationTargetId: snapshot.publicationTargetId,
    recording: {
      ...snapshot.recording,
      speakerAudio: [
        {
          audioLocator: "recordings/recording-e2e/speaker-a.ogg",
          speakerId: "speaker-a",
          timelineOffsetMs: 0,
        },
        {
          audioLocator: "recordings/recording-e2e/speaker-b.ogg",
          speakerId: "speaker-b",
          timelineOffsetMs: 1_000,
        },
      ],
    },
  }).toSnapshot();
}

function completedBatchV2Response(): Readonly<Record<string, unknown>> {
  return {
    job_id: jobId,
    result: {
      duration_seconds: 2.8,
      language: "multi",
      model: "nova-3",
      provider: "deepgram",
      readable_segments: [{
        end: 2.8,
        source_utterance_indices: [0, 1],
        start: 0,
        transcript: "Релиз в пятницу.",
      }],
      text: "Релиз в пятницу.",
      utterances: [
        { confidence: 0.99, end: 1.25, start: 0, transcript: "Релиз" },
        { confidence: 0.98, end: 2.8, start: 1.25, transcript: "в пятницу" },
      ],
    },
    status: "completed",
    success: true,
  };
}

function singleTurnBatchV2Response(
  includeReadableSegment: boolean,
): Readonly<Record<string, unknown>> {
  const firstSpeaker = includeReadableSegment;
  const transcript = firstSpeaker ? "первый трек" : "второй трек";
  return {
    job_id: jobId,
    result: {
      duration_seconds: 1,
      language: "multi",
      model: "nova-3",
      provider: "deepgram",
      ...(includeReadableSegment ? {
        readable_segments: [{
          end: 1,
          source_utterance_indices: [0],
          start: 0,
          transcript,
        }],
      } : {}),
      text: transcript,
      utterances: [{ confidence: 0.99, end: 1, start: 0, transcript }],
    },
    status: "completed",
    success: true,
  };
}

function validOgg(marker = 0): Uint8Array {
  const bytes = new Uint8Array(27);
  bytes.set([79, 103, 103, 83]);
  bytes[5] = marker;
  return bytes;
}
