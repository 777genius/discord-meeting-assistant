import {
  type FinalTranscriptionPort,
} from "@discord-meeting/meeting-core/transcription";
import { createS3BinaryArtifactReader } from "@discord-meeting/object-storage-adapter";
import {
  FetchSpeachesTranscriptionClient,
  SpeachesFinalTranscriptionAdapter,
} from "@discord-meeting/speaches-adapter";
import {
  FetchVoicetextBatchClient,
  VoicetextBatchFinalTranscriptionAdapter,
  batchEndpointFromWebSocketUrl,
  type VoicetextBatchFinalTranscriptionOptions,
} from "@discord-meeting/voicetext-adapter";

import type { PlatformConfig } from "../config.js";
import { S3CompleteOggArtifactReader, S3OggAudioArtifactReader } from "../adapters/outbound/s3-ogg-audio-artifact-reader.js";
import { InProcessFinalTranscriptionAdmissionPort } from "../application/final-transcription-admission-port.js";
import { meetingVocabulary } from "./meeting-vocabulary.js";

// Ten human tracks plus the authoritative Botik playback track.
const maximumFinalSpeakerTracks = 11;

export function createVoicetextBatchFinalTranscriptionOptions(
  config: NonNullable<PlatformConfig["voicetext"]>,
): VoicetextBatchFinalTranscriptionOptions {
  return {
    keyterms: meetingVocabulary,
    maxArtifactBytesPerSpeaker: config.batchMaxArtifactBytes,
    maxConcurrency: config.batchMaxConcurrency,
    // Nova-3 may emit bounded overlapping utterance hypotheses on long tracks.
    // The adapter deterministically trims or merges them before they cross the
    // provider boundary; larger overlaps still fail closed.
    maxSegmentOverlapMs: 10_000,
    // Reserve the worst-case capacity before any provider upload. The bounded
    // worker pool retains at most maxConcurrency complete artifacts at once.
    maxTotalArtifactBytes:
      config.batchMaxArtifactBytes * maximumFinalSpeakerTracks,
    maxSpeakerTracks: maximumFinalSpeakerTracks,
    pollTimeoutMs: 900_000,
  };
}

export function createFinalTranscriber(
  config: PlatformConfig,
  artifactReader: ReturnType<typeof createS3BinaryArtifactReader>,
): FinalTranscriptionPort {
  if (config.transcriptionProvider === "speaches") {
    return createSpeachesFinalTranscriber(config, artifactReader);
  }
  return createVoicetextFinalTranscriber(config, artifactReader);
}

function createSpeachesFinalTranscriber(
  config: PlatformConfig,
  artifactReader: ReturnType<typeof createS3BinaryArtifactReader>,
): FinalTranscriptionPort {
  return new SpeachesFinalTranscriptionAdapter(
    new FetchSpeachesTranscriptionClient(config.speaches.baseUrl),
    new S3OggAudioArtifactReader(artifactReader),
    {
      language: "ru",
      maxBytesPerSpeaker: 64 * 1_024 * 1_024,
      maxSpeakerTracks: maximumFinalSpeakerTracks,
      model: config.speaches.model,
      vocabulary: meetingVocabulary,
    },
  );
}

function createVoicetextFinalTranscriber(
  config: PlatformConfig,
  artifactReader: ReturnType<typeof createS3BinaryArtifactReader>,
): FinalTranscriptionPort {
  if (
    config.voicetext === undefined ||
    config.secrets.voicetextServiceToken === undefined
  ) {
    throw new Error("Voicetext transcription configuration is incomplete");
  }
  const batchTranscriber = new VoicetextBatchFinalTranscriptionAdapter(
    new FetchVoicetextBatchClient({
      endpoint: batchEndpointFromWebSocketUrl(config.voicetext.webSocketUrl),
      token: config.secrets.voicetextServiceToken,
    }),
    new S3CompleteOggArtifactReader(artifactReader),
    createVoicetextBatchFinalTranscriptionOptions(config.voicetext),
  );
  return new InProcessFinalTranscriptionAdmissionPort(
    batchTranscriber,
    config.voicetext.batchMaxConcurrentMeetings,
  );
}
