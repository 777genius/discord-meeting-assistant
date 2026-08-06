import { requireNonEmpty } from "./errors.js";

declare const recordingIdentifierBrand: unique symbol;

type RecordingIdentifier<Kind extends string> = string & {
  readonly [recordingIdentifierBrand]: Kind;
};

export type RecordingId = RecordingIdentifier<"RecordingId">;
export type SpeakerId = RecordingIdentifier<"SpeakerId">;

export const createRecordingId = (value: string): RecordingId =>
  requireNonEmpty(value, "recordingId") as RecordingId;

export const createSpeakerId = (value: string): SpeakerId =>
  requireNonEmpty(value, "speakerId") as SpeakerId;
