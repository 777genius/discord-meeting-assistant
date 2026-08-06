import { requireNonEmpty } from "./errors.js";

declare const transcriptionIdentifierBrand: unique symbol;

type TranscriptionIdentifier<Kind extends string> = string & {
  readonly [transcriptionIdentifierBrand]: Kind;
};

export type TranscriptId = TranscriptionIdentifier<"TranscriptId">;
export type TranscriptTurnId = TranscriptionIdentifier<"TranscriptTurnId">;

export const createTranscriptId = (value: string): TranscriptId =>
  requireNonEmpty(value, "transcriptId") as TranscriptId;

export const createTranscriptTurnId = (value: string): TranscriptTurnId =>
  requireNonEmpty(value, "turnId") as TranscriptTurnId;
