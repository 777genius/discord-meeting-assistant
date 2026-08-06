import {
  type FinalTranscriptionRequest,
} from "@discord-meeting/meeting-core/transcription";
import {
  type SpeakerAudioReferenceSnapshot,
} from "@discord-meeting/meeting-core/recording";

import type {
  BinaryAudioArtifact,
  BinaryAudioChunk,
} from "./binary-audio-artifact-reader.js";

export interface SpeachesFinalTranscriptionOptions {
  readonly artifactReadTimeoutMs?: number;
  readonly language?: string;
  readonly maxBytesPerChunk?: number;
  readonly maxBytesPerSpeaker?: number;
  readonly maxChunksPerSpeaker?: number;
  readonly maxConcurrency?: number;
  readonly maxSpeakerTracks?: number;
  readonly maxTotalAudioBytes?: number;
  readonly model: string;
  readonly providerRequestTimeoutMs?: number;
  readonly vocabulary?: readonly string[];
}

export type CancellableFinalTranscriptionRequest = FinalTranscriptionRequest & {
  readonly signal?: AbortSignal;
};

export interface ValidatedSpeachesFinalTranscriptionOptions {
  readonly artifactReadTimeoutMs: number;
  readonly hotwords: string | undefined;
  readonly language: string | undefined;
  readonly maxBytesPerChunk: number;
  readonly maxBytesPerSpeaker: number;
  readonly maxChunksPerSpeaker: number;
  readonly maxConcurrency: number;
  readonly maxSpeakerTracks: number;
  readonly maxTotalAudioBytes: number;
  readonly model: string;
  readonly prompt: string | undefined;
  readonly providerRequestTimeoutMs: number;
}

export interface ResolvedSpeakerAudio {
  readonly artifact: BinaryAudioArtifact;
  readonly reference: SpeakerAudioReferenceSnapshot;
  readonly sourceAudioIndex: number;
}

export interface ChunkTask {
  readonly artifact: BinaryAudioArtifact;
  readonly chunk: BinaryAudioChunk;
  readonly chunkIndex: number;
  readonly reference: SpeakerAudioReferenceSnapshot;
  readonly sourceAudioIndex: number;
}

export interface ProviderTranscriptTurn {
  readonly endMs: number;
  readonly providerSegmentId: string;
  readonly speakerId: string;
  readonly stableTurnId: string;
  readonly startMs: number;
  readonly text: string;
}
