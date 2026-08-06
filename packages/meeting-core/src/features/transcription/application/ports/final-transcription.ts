import type { RecordingArtifactSnapshot } from "../../../recording/index.js";
import type { TranscriptTurnSnapshot } from "../../domain/transcript.js";

export interface FinalTranscriptionFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type FinalTranscriptionResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly failure: FinalTranscriptionFailure; readonly ok: false };

export interface FinalTranscriptionRequest {
  readonly idempotencyKey: string;
  readonly meetingId: string;
  readonly recording: RecordingArtifactSnapshot;
  /** Cancels only this in-flight attempt; retries reuse the same identity. */
  readonly signal?: AbortSignal;
}

export interface GeneratedTranscript {
  readonly transcriptId: string;
  readonly turns: readonly TranscriptTurnSnapshot[];
  readonly version: number;
}

export interface FinalTranscriptionPort {
  transcribe(
    request: FinalTranscriptionRequest,
  ): Promise<FinalTranscriptionResult<GeneratedTranscript>>;
}
