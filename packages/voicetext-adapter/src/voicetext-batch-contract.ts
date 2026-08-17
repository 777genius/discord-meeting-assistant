export type VoicetextBatchProfile = "deepgram-nova-3" | "elevenlabs-scribe-v2";

export interface VoicetextBatchContractIdentity {
  readonly contractVersion: "2" | "3";
  readonly language: "multi";
  readonly model: "nova-3" | "scribe_v2";
  readonly provider: "deepgram" | "elevenlabs";
}

export const defaultVoicetextBatchProfile: VoicetextBatchProfile = "deepgram-nova-3";

export function voicetextBatchContractIdentity(
  profile: VoicetextBatchProfile,
): VoicetextBatchContractIdentity {
  if (profile === "deepgram-nova-3") {
    return { contractVersion: "2", language: "multi", model: "nova-3", provider: "deepgram" };
  }
  return { contractVersion: "3", language: "multi", model: "scribe_v2", provider: "elevenlabs" };
}

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
