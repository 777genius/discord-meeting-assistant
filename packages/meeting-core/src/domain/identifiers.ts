import { requireNonEmpty } from "./errors.js";

declare const identifierBrand: unique symbol;

type Identifier<Kind extends string> = string & {
  readonly [identifierBrand]: Kind;
};

export type MeetingId = Identifier<"MeetingId">;
export type RecordingId = Identifier<"RecordingId">;
export type SpeakerId = Identifier<"SpeakerId">;
export type TranscriptId = Identifier<"TranscriptId">;
export type TranscriptTurnId = Identifier<"TranscriptTurnId">;
export type SummaryId = Identifier<"SummaryId">;
export type PublicationTargetId = Identifier<"PublicationTargetId">;
export type ExternalPublicationId = Identifier<"ExternalPublicationId">;

function identifier<Kind extends string>(value: string, field: string): Identifier<Kind> {
  return requireNonEmpty(value, field) as Identifier<Kind>;
}

export const createMeetingId = (value: string): MeetingId =>
  identifier<"MeetingId">(value, "meetingId");

export const createRecordingId = (value: string): RecordingId =>
  identifier<"RecordingId">(value, "recordingId");

export const createSpeakerId = (value: string): SpeakerId =>
  identifier<"SpeakerId">(value, "speakerId");

export const createTranscriptId = (value: string): TranscriptId =>
  identifier<"TranscriptId">(value, "transcriptId");

export const createTranscriptTurnId = (value: string): TranscriptTurnId =>
  identifier<"TranscriptTurnId">(value, "turnId");

export const createSummaryId = (value: string): SummaryId =>
  identifier<"SummaryId">(value, "summaryId");

export const createPublicationTargetId = (value: string): PublicationTargetId =>
  identifier<"PublicationTargetId">(value, "publicationTargetId");

export const createExternalPublicationId = (value: string): ExternalPublicationId =>
  identifier<"ExternalPublicationId">(value, "externalPublicationId");
