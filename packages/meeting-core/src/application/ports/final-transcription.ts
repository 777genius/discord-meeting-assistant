import type { RecordingArtifactSnapshot } from "../../domain/recording.js";
import type { TranscriptTurnSnapshot } from "../../domain/transcript.js";
import type { PortResult } from "./shared.js";

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
  ): Promise<PortResult<GeneratedTranscript>>;
}
