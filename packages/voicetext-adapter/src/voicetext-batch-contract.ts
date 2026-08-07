export const voicetextBatchContractVersion = "2";
export const voicetextBatchLanguage = "multi";
export const voicetextBatchModel = "nova-3";
export const voicetextBatchProvider = "deepgram";

export interface VoicetextBatchUtterance {
  readonly confidence?: number;
  readonly endSeconds: number;
  readonly startSeconds: number;
  readonly transcript: string;
}

export interface VoicetextBatchReadableSegment {
  readonly endSeconds: number;
  readonly sourceUtteranceIndices: readonly number[];
  readonly startSeconds: number;
  readonly transcript: string;
}

export interface VoicetextBatchTranscriptionResult {
  readonly durationSeconds: number;
  readonly readableSegments: readonly VoicetextBatchReadableSegment[];
  readonly utterances: readonly VoicetextBatchUtterance[];
}

export type VoicetextBatchTaskResult =
  | {
      readonly jobId: string;
      readonly kind: "completed";
      readonly result: VoicetextBatchTranscriptionResult;
    }
  | {
      readonly errorCode: string;
      readonly jobId: string;
      readonly kind: "failed";
      readonly retryable: false;
    }
  | {
      readonly jobId: string;
      readonly kind: "pending";
      readonly nextAction: "poll" | "retry";
      readonly retryAfterMs: number;
    };
