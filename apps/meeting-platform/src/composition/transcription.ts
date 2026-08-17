import {
  type FinalTranscriptionPort,
  type FinalTranscriptionRequest,
  type FinalTranscriptionResult,
  type GeneratedTranscript,
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
  type VoicetextBatchProfile,
} from "@discord-meeting/voicetext-adapter";

import type { PlatformConfig } from "../config.js";
import { S3CompleteOggArtifactReader, S3OggAudioArtifactReader } from "../adapters/outbound/s3-ogg-audio-artifact-reader.js";
import { InProcessFinalTranscriptionAdmissionPort } from "../application/final-transcription-admission-port.js";
import { meetingVocabulary } from "./meeting-vocabulary.js";

// Ten human tracks plus the authoritative Botik playback track.
const maximumFinalSpeakerTracks = 11;

export const legacyVoicetextBatchExecutionBinding =
  "voicetext-batch-v2:deepgram-nova-3";
export const elevenLabsVoicetextBatchExecutionBinding =
  "voicetext-batch-v3:elevenlabs-scribe-v2";
export const speachesFinalTranscriptionExecutionBinding = "speaches-v1";

export type FinalTranscriptionExecutionBinding =
  | typeof legacyVoicetextBatchExecutionBinding
  | typeof elevenLabsVoicetextBatchExecutionBinding
  | typeof speachesFinalTranscriptionExecutionBinding;

type FinalTranscriptionBindingConfig = Readonly<{
  transcriptionLegacyExecutionBinding?:
    | typeof legacyVoicetextBatchExecutionBinding
    | typeof speachesFinalTranscriptionExecutionBinding;
  transcriptionProvider: PlatformConfig["transcriptionProvider"];
  voicetext?: Pick<NonNullable<PlatformConfig["voicetext"]>, "batchProfile">;
}>;

interface TranscriptionExecutionBindingReader {
  getTranscriptionExecutionBinding(meetingId: string): Promise<string | undefined>;
}

export function voicetextBatchExecutionBinding(
  profile: VoicetextBatchProfile,
): FinalTranscriptionExecutionBinding {
  return profile === "deepgram-nova-3"
    ? legacyVoicetextBatchExecutionBinding
    : elevenLabsVoicetextBatchExecutionBinding;
}

export function selectedFinalTranscriptionExecutionBinding(
  config: FinalTranscriptionBindingConfig,
): FinalTranscriptionExecutionBinding {
  return config.transcriptionProvider === "speaches"
    ? speachesFinalTranscriptionExecutionBinding
    : voicetextBatchExecutionBinding(config.voicetext?.batchProfile ?? "deepgram-nova-3");
}

export function legacyFinalTranscriptionExecutionBinding(
  config: FinalTranscriptionBindingConfig,
): FinalTranscriptionExecutionBinding {
  if (config.transcriptionLegacyExecutionBinding === undefined) {
    throw new Error("explicit historical transcription binding is required");
  }
  return config.transcriptionLegacyExecutionBinding;
}

export function supportedFinalTranscriptionExecutionBindings(
  config: Pick<PlatformConfig, "transcriptionProvider">,
): ReadonlySet<FinalTranscriptionExecutionBinding> {
  return config.transcriptionProvider === "speaches"
    ? new Set([speachesFinalTranscriptionExecutionBinding])
    : new Set([
      legacyVoicetextBatchExecutionBinding,
      elevenLabsVoicetextBatchExecutionBinding,
    ]);
}

export class DurableFinalTranscriptionRouter implements FinalTranscriptionPort {
  public constructor(
    private readonly bindings: TranscriptionExecutionBindingReader,
    private readonly delegates: ReadonlyMap<FinalTranscriptionExecutionBinding, FinalTranscriptionPort>,
  ) {}

  public async transcribe(
    request: FinalTranscriptionRequest,
  ): Promise<FinalTranscriptionResult<GeneratedTranscript>> {
    const binding = await this.bindings.getTranscriptionExecutionBinding(request.meetingId);
    if (binding === undefined) {
      return {
        failure: {
          code: "FINAL_TRANSCRIPTION_BINDING_MISSING",
          message: "The durable final transcription binding is missing",
          retryable: false,
        },
        ok: false,
      };
    }
    const delegate = this.delegates.get(binding as FinalTranscriptionExecutionBinding);
    if (delegate === undefined) {
      return {
        failure: {
          code: "FINAL_TRANSCRIPTION_BINDING_UNSUPPORTED",
          message: "The durable final transcription binding is unsupported",
          retryable: false,
        },
        ok: false,
      };
    }
    return delegate.transcribe(request);
  }
}

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
  bindings: TranscriptionExecutionBindingReader,
): FinalTranscriptionPort {
  if (config.transcriptionProvider === "speaches") {
    return new DurableFinalTranscriptionRouter(
      bindings,
      new Map([
        [
          speachesFinalTranscriptionExecutionBinding,
          createSpeachesFinalTranscriber(config, artifactReader),
        ],
      ]),
    );
  }
  return createVoicetextFinalTranscriber(config, artifactReader, bindings);
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
  bindings: TranscriptionExecutionBindingReader,
): FinalTranscriptionPort {
  if (
    config.voicetext === undefined ||
    config.secrets.voicetextServiceToken === undefined
  ) {
    throw new Error("Voicetext transcription configuration is incomplete");
  }
  const delegates = new Map<FinalTranscriptionExecutionBinding, FinalTranscriptionPort>([
    [
      legacyVoicetextBatchExecutionBinding,
      createVoicetextBatchDelegate("deepgram-nova-3", config, artifactReader),
    ],
    [
      elevenLabsVoicetextBatchExecutionBinding,
      createVoicetextBatchDelegate("elevenlabs-scribe-v2", config, artifactReader),
    ],
  ]);
  const router = new DurableFinalTranscriptionRouter(bindings, delegates);
  return new InProcessFinalTranscriptionAdmissionPort(
    router,
    config.voicetext.batchMaxConcurrentMeetings,
  );
}

function createVoicetextBatchDelegate(
  profile: VoicetextBatchProfile,
  config: PlatformConfig,
  artifactReader: ReturnType<typeof createS3BinaryArtifactReader>,
): FinalTranscriptionPort {
  if (
    config.voicetext === undefined ||
    config.secrets.voicetextServiceToken === undefined
  ) {
    throw new Error("Voicetext transcription configuration is incomplete");
  }
  return new VoicetextBatchFinalTranscriptionAdapter(
    new FetchVoicetextBatchClient({
      endpoint: batchEndpointFromWebSocketUrl(config.voicetext.webSocketUrl),
      profile,
      token: config.secrets.voicetextServiceToken,
    }),
    new S3CompleteOggArtifactReader(artifactReader),
    createVoicetextBatchFinalTranscriptionOptions(config.voicetext),
  );
}
