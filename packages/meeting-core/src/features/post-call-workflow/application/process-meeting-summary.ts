import {
  Meeting,
  MeetingLifecycleInvariantError,
  type MeetingRepository,
  type ProcessingStage,
  type StageFailure,
} from "../../meeting-lifecycle/index.js";
import {
  EvidenceBackedSummary,
  MeetingIntelligenceInvariantError,
  type SummaryGenerationPort,
} from "../../meeting-intelligence/index.js";
import type { SummaryPublicationPort } from "../../publishing/index.js";
import {
  FinalTranscript,
  TranscriptionInvariantError,
  type FinalTranscriptionPort,
  type FinalTranscriptionResult,
  type GeneratedTranscript,
} from "../../transcription/index.js";

export type ProcessMeetingSummaryResult =
  | { readonly status: "not-found" }
  | {
      readonly failure: StageFailure;
      readonly stage: ProcessingStage;
      readonly status: "failed";
    }
  | {
      readonly externalPublicationId: string;
      readonly idempotencyKey: string;
      readonly reused: boolean;
      readonly status: "published";
    };

export interface ProcessMeetingSummaryDependencies {
  readonly meetings: MeetingRepository;
  readonly publisher: SummaryPublicationPort;
  readonly summarizer: SummaryGenerationPort;
  readonly transcriber: FinalTranscriptionPort;
}

function identityPart(value: string): string {
  return `${value.length}:${value}`;
}

function operationIdentity(operation: string, ...parts: readonly string[]): string {
  return [operation, ...parts.map(identityPart)].join("|");
}

function immutableArtifactIdentityParts(
  meeting: Meeting,
): readonly string[] | null {
  const parts: string[] = [];
  for (const reference of meeting.recording.speakerAudio) {
    if (
      reference.artifactRevision === undefined ||
      reference.checksumSha256 === undefined ||
      reference.sizeBytes === undefined
    ) {
      return null;
    }
    parts.push(
      reference.audioLocator,
      reference.artifactRevision,
      reference.checksumSha256,
      String(reference.sizeBytes),
    );
  }
  return parts;
}

function unexpectedFailure(stage: ProcessingStage, error: unknown): StageFailure {
  return {
    code: `UNEXPECTED_${stage.toUpperCase()}_FAILURE`,
    message: error instanceof Error ? error.message : `Unexpected ${stage} failure`,
    retryable: true,
  };
}

function invalidOutputFailure(stage: ProcessingStage, error: unknown): StageFailure {
  return {
    code: `INVALID_${stage.toUpperCase()}_OUTPUT`,
    message: error instanceof Error ? error.message : `Invalid ${stage} output`,
    retryable: false,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

export class ProcessMeetingSummary {
  private readonly meetings: MeetingRepository;
  private readonly publisher: SummaryPublicationPort;
  private readonly summarizer: SummaryGenerationPort;
  private readonly transcriber: FinalTranscriptionPort;

  public constructor(dependencies: ProcessMeetingSummaryDependencies) {
    this.meetings = dependencies.meetings;
    this.publisher = dependencies.publisher;
    this.summarizer = dependencies.summarizer;
    this.transcriber = dependencies.transcriber;
  }

  public async execute(
    meetingId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ProcessMeetingSummaryResult> {
    const { signal } = options;
    throwIfAborted(signal);
    const snapshot = await this.meetings.findById(meetingId);
    throwIfAborted(signal);
    if (snapshot === null) {
      return { status: "not-found" };
    }

    const meeting = Meeting.restore(snapshot);
    if (meeting.publication !== null) {
      return {
        externalPublicationId: meeting.publication.externalPublicationId,
        idempotencyKey: meeting.publication.idempotencyKey,
        reused: true,
        status: "published",
      };
    }

    const transcriptionResult = await this.ensureTranscript(meeting, signal);
    if (transcriptionResult !== null) {
      return transcriptionResult;
    }

    const summaryResult = await this.ensureSummary(meeting, signal);
    if (summaryResult !== null) {
      return summaryResult;
    }

    return this.ensurePublication(meeting, signal);
  }

  private async ensureTranscript(
    meeting: Meeting,
    signal: AbortSignal | undefined,
  ): Promise<ProcessMeetingSummaryResult | null> {
    throwIfAborted(signal);
    if (meeting.transcript !== null) {
      return null;
    }

    const blocked = this.currentStageResult(meeting, "transcription");
    if (blocked !== null) {
      return blocked;
    }

    const expectedRevision = meeting.revision;
    const disposition = meeting.beginTranscription();
    if (disposition === "started") {
      await this.meetings.save(meeting.toSnapshot(), expectedRevision);
    }
    throwIfAborted(signal);

    const artifactIdentity = immutableArtifactIdentityParts(meeting);
    if (artifactIdentity === null) {
      return this.fail(
        meeting,
        "transcription",
        {
          code: "IMMUTABLE_ARTIFACT_IDENTITY_REQUIRED",
          message: "authoritative recording lacks immutable artifact identity",
          retryable: false,
        },
        signal,
      );
    }

    let result: FinalTranscriptionResult<GeneratedTranscript>;
    try {
      result = await this.transcriber.transcribe({
        idempotencyKey: operationIdentity(
          "final-transcription:v2",
          meeting.meetingId,
          meeting.recording.recordingId,
          ...artifactIdentity,
        ),
        meetingId: meeting.meetingId,
        recording: meeting.recording.toSnapshot(),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throwIfAborted(signal);
      return this.fail(
        meeting,
        "transcription",
        unexpectedFailure("transcription", error),
        signal,
      );
    }

    throwIfAborted(signal);
    if (!result.ok) {
      return this.fail(meeting, "transcription", result.failure, signal);
    }

    try {
      throwIfAborted(signal);
      const transcript = FinalTranscript.create({
        readableSegments: result.value.readableSegments ?? [],
        recordingId: meeting.recording.recordingId,
        transcriptId: result.value.transcriptId,
        turns: result.value.turns,
        version: result.value.version,
      });
      const beforeCompletion = meeting.revision;
      throwIfAborted(signal);
      meeting.completeTranscription(transcript);
      await this.meetings.save(meeting.toSnapshot(), beforeCompletion);
      return null;
    } catch (error) {
      if (
        error instanceof TranscriptionInvariantError ||
        error instanceof MeetingLifecycleInvariantError
      ) {
        return this.fail(
          meeting,
          "transcription",
          invalidOutputFailure("transcription", error),
          signal,
        );
      }
      throw error;
    }
  }

  private async ensureSummary(
    meeting: Meeting,
    signal: AbortSignal | undefined,
  ): Promise<ProcessMeetingSummaryResult | null> {
    throwIfAborted(signal);
    if (meeting.summary !== null) {
      return null;
    }
    const transcript = meeting.transcript;
    if (transcript === null) {
      throw new MeetingLifecycleInvariantError(
        "INVALID_LIFECYCLE_STATE",
        "summary orchestration requires a final transcript",
      );
    }

    const blocked = this.currentStageResult(meeting, "summary");
    if (blocked !== null) {
      return blocked;
    }

    const expectedRevision = meeting.revision;
    const disposition = meeting.beginSummary();
    if (disposition === "started") {
      await this.meetings.save(meeting.toSnapshot(), expectedRevision);
    }
    throwIfAborted(signal);

    let result;
    try {
      result = await this.summarizer.generate({
        idempotencyKey: operationIdentity(
          "evidence-summary:v3",
          meeting.meetingId,
          transcript.transcriptId,
        ),
        meetingId: meeting.meetingId,
        transcript: transcript.toSnapshot(),
      });
    } catch (error) {
      throwIfAborted(signal);
      return this.fail(meeting, "summary", unexpectedFailure("summary", error), signal);
    }

    throwIfAborted(signal);
    if (!result.ok) {
      return this.fail(meeting, "summary", result.failure, signal);
    }

    try {
      throwIfAborted(signal);
      const summary = EvidenceBackedSummary.create(
        {
          ...result.value,
          transcriptId: transcript.transcriptId,
        },
        transcript,
      );
      const beforeCompletion = meeting.revision;
      throwIfAborted(signal);
      meeting.completeSummary(summary);
      await this.meetings.save(meeting.toSnapshot(), beforeCompletion);
      return null;
    } catch (error) {
      if (
        error instanceof MeetingIntelligenceInvariantError ||
        error instanceof MeetingLifecycleInvariantError
      ) {
        return this.fail(
          meeting,
          "summary",
          invalidOutputFailure("summary", error),
          signal,
        );
      }
      throw error;
    }
  }

  private async ensurePublication(
    meeting: Meeting,
    signal: AbortSignal | undefined,
  ): Promise<ProcessMeetingSummaryResult> {
    throwIfAborted(signal);
    const summary = meeting.summary;
    const transcript = meeting.transcript;
    if (summary === null || transcript === null) {
      throw new MeetingLifecycleInvariantError(
        "INVALID_LIFECYCLE_STATE",
        "publication orchestration requires an accepted summary and final transcript",
      );
    }

    const blocked = this.currentStageResult(meeting, "publication");
    if (blocked !== null) {
      return blocked;
    }

    const expectedRevision = meeting.revision;
    const disposition = meeting.beginPublication();
    if (disposition === "started") {
      await this.meetings.save(meeting.toSnapshot(), expectedRevision);
    }
    throwIfAborted(signal);

    const idempotencyKey = meeting.publicationIdempotencyKey();
    let result;
    try {
      result = await this.publisher.publish({
        idempotencyKey,
        meetingId: meeting.meetingId,
        publicationTargetId: meeting.publicationTargetId,
        summary: summary.toSnapshot(),
        transcript: transcript.toSnapshot(),
      });
    } catch (error) {
      throwIfAborted(signal);
      return this.fail(
        meeting,
        "publication",
        unexpectedFailure("publication", error),
        signal,
      );
    }

    throwIfAborted(signal);
    if (!result.ok) {
      return this.fail(meeting, "publication", result.failure, signal);
    }

    try {
      throwIfAborted(signal);
      const beforeCompletion = meeting.revision;
      meeting.completePublication({
        externalPublicationId: result.value.externalPublicationId,
        idempotencyKey,
        ...(result.value.publisherIdentity === undefined
          ? {}
          : { publisherIdentity: result.value.publisherIdentity }),
      });
      throwIfAborted(signal);
      await this.meetings.save(meeting.toSnapshot(), beforeCompletion);
    } catch (error) {
      if (error instanceof MeetingLifecycleInvariantError) {
        return this.fail(
          meeting,
          "publication",
          invalidOutputFailure("publication", error),
          signal,
        );
      }
      throw error;
    }

    const publication = meeting.publication;
    if (publication === null) {
      throw new MeetingLifecycleInvariantError(
        "INVALID_LIFECYCLE_STATE",
        "successful publication must produce a receipt",
      );
    }
    return {
      externalPublicationId: publication.externalPublicationId,
      idempotencyKey: publication.idempotencyKey,
      reused: false,
      status: "published",
    };
  }

  private currentStageResult(
    meeting: Meeting,
    stage: ProcessingStage,
  ): ProcessMeetingSummaryResult | null {
    const state = meeting.stage(stage);
    if (state.status === "failed" && !state.failure.retryable) {
      return { failure: state.failure, stage, status: "failed" };
    }
    return null;
  }

  private async fail(
    meeting: Meeting,
    stage: ProcessingStage,
    failure: StageFailure,
    signal: AbortSignal | undefined,
  ): Promise<ProcessMeetingSummaryResult> {
    throwIfAborted(signal);
    const expectedRevision = meeting.revision;
    if (stage === "transcription") {
      meeting.failTranscription(failure);
    } else if (stage === "summary") {
      meeting.failSummary(failure);
    } else {
      meeting.failPublication(failure);
    }
    await this.meetings.save(meeting.toSnapshot(), expectedRevision);
    return { failure, stage, status: "failed" };
  }
}
