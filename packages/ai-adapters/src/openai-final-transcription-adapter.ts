import {
  type FinalTranscriptionPort,
  type FinalTranscriptionRequest,
  type GeneratedTranscript,
  type TranscriptTurnSnapshot,
  type FinalTranscriptionResult,
} from "@discord-meeting/meeting-core/transcription";
import {
  type SpeakerAudioReferenceSnapshot,
} from "@discord-meeting/meeting-core/recording";

import type { AudioContent, AudioContentReader } from "./audio-content-reader.js";
import { deterministicAdapterId } from "./deterministic-id.js";
import { OpenAiAdapterError, toOpenAiPortFailure } from "./errors.js";
import type { OpenAiTranscriptionClient } from "./openai-client.js";
import { verboseTranscriptionSchema } from "./provider-schemas.js";

const supportedAudioExtension = /\.(?:flac|m4a|mp3|mp4|mpeg|mpga|ogg|wav|webm)$/iu;
const maxOpenAiTranscriptionBytes = 25 * 1_024 * 1_024;

export interface OpenAiFinalTranscriptionOptions {
  readonly language?: string;
  readonly maxConcurrency?: number;
  readonly vocabulary?: readonly string[];
}

interface ProviderTranscriptTurn {
  readonly endMs: number;
  readonly providerSegmentId: string;
  readonly sourceAudioIndex: number;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
}

export class OpenAiFinalTranscriptionAdapter implements FinalTranscriptionPort {
  private readonly language: string | undefined;
  private readonly maxConcurrency: number;
  private readonly prompt: string | undefined;

  public constructor(
    private readonly client: OpenAiTranscriptionClient,
    private readonly audioContentReader: AudioContentReader,
    options: OpenAiFinalTranscriptionOptions = {},
  ) {
    const maxConcurrency = options.maxConcurrency ?? 2;
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) {
      throw new OpenAiAdapterError(
        "invalid_input",
        "maxConcurrency must be an integer between 1 and 16",
      );
    }
    if (options.language !== undefined && options.language.trim().length === 0) {
      throw new OpenAiAdapterError("invalid_input", "language must not be empty");
    }

    this.language = options.language?.trim();
    this.maxConcurrency = maxConcurrency;
    this.prompt = buildVocabularyPrompt(options.vocabulary);
  }

  public async transcribe(
    request: FinalTranscriptionRequest,
  ): Promise<FinalTranscriptionResult<GeneratedTranscript>> {
    try {
      return { ok: true, value: await this.transcribeOrThrow(request) };
    } catch (error: unknown) {
      request.signal?.throwIfAborted();
      return {
        ok: false,
        failure: toOpenAiPortFailure(error, "transcription"),
      };
    }
  }

  private async transcribeOrThrow(
    request: FinalTranscriptionRequest,
  ): Promise<GeneratedTranscript> {
    validateTranscriptionRequest(request);
    request.signal?.throwIfAborted();

    const chunkResults = await mapWithConcurrency(
      request.recording.speakerAudio,
      this.maxConcurrency,
      request.signal,
      async (reference, sourceAudioIndex) =>
        this.transcribeSpeakerAudio(
          reference,
          sourceAudioIndex,
          request.idempotencyKey,
          request.signal,
        ),
    );
    const providerTurns = chunkResults.flat().toSorted(compareProviderTurns);

    const sourceSegmentKeys = new Set<string>();
    for (const turn of providerTurns) {
      const sourceSegmentKey = `${turn.sourceAudioIndex}:${turn.providerSegmentId}`;
      if (sourceSegmentKeys.has(sourceSegmentKey)) {
        throw new OpenAiAdapterError(
          "invalid_provider_response",
          "OpenAI returned duplicate segment identities",
        );
      }
      sourceSegmentKeys.add(sourceSegmentKey);
    }

    return {
      transcriptId: deterministicAdapterId("transcript", request.idempotencyKey),
      version: 1,
      turns: providerTurns.map(
        (turn, index): TranscriptTurnSnapshot => ({
          turnId: deterministicAdapterId("turn", request.idempotencyKey, index + 1),
          speakerId: turn.speakerId,
          startMs: turn.startMs,
          endMs: turn.endMs,
          text: turn.text,
        }),
      ),
    };
  }

  private async transcribeSpeakerAudio(
    reference: SpeakerAudioReferenceSnapshot,
    sourceAudioIndex: number,
    idempotencyKey: string,
    signal: AbortSignal | undefined,
  ): Promise<readonly ProviderTranscriptTurn[]> {
    signal?.throwIfAborted();
    const audio = await this.audioContentReader.read(
      reference.audioLocator,
      signal === undefined ? {} : { signal },
    );
    signal?.throwIfAborted();
    validateAudioContent(audio);

    const providerResponse = await this.client.createTranscription({
      audio: audio.bytes,
      fileName: audio.fileName,
      idempotencyKey: deterministicAdapterId(
        "transcription-request",
        idempotencyKey,
        sourceAudioIndex + 1,
      ),
      mediaType: audio.mediaType,
      model: "whisper-1",
      ...(this.language === undefined ? {} : { language: this.language }),
      ...(this.prompt === undefined ? {} : { prompt: this.prompt }),
      ...(signal === undefined ? {} : { signal }),
    });
    signal?.throwIfAborted();

    const parsed = verboseTranscriptionSchema.safeParse(providerResponse);
    if (!parsed.success) {
      throw new OpenAiAdapterError(
        "invalid_provider_response",
        "OpenAI returned an invalid verbose transcription",
        { issuePaths: parsed.error.issues.map((issue) => issue.path.join(".")) },
      );
    }

    const segments = parsed.data.segments ?? [];
    if (segments.length === 0 && parsed.data.text.trim().length > 0) {
      throw new OpenAiAdapterError(
        "invalid_provider_response",
        "OpenAI returned transcript text without required segment timestamps",
      );
    }

    return segments.flatMap((segment): readonly ProviderTranscriptTurn[] => {
      const text = segment.text.trim();
      if (text.length === 0) {
        return [];
      }

      const startMs = addMilliseconds(reference.timelineOffsetMs, segment.start);
      const endMs = addMilliseconds(reference.timelineOffsetMs, segment.end);
      if (endMs <= startMs) {
        throw new OpenAiAdapterError(
          "invalid_provider_response",
          "OpenAI segment duration is below millisecond precision",
        );
      }

      return [
        {
          endMs,
          providerSegmentId: String(segment.id),
          sourceAudioIndex,
          speakerId: reference.speakerId,
          startMs,
          text,
        },
      ];
    });
  }
}

function validateTranscriptionRequest(request: FinalTranscriptionRequest): void {
  if (
    request.idempotencyKey.trim().length === 0 ||
    request.meetingId.trim().length === 0 ||
    request.recording.recordingId.trim().length === 0 ||
    request.recording.manifestLocator.trim().length === 0
  ) {
    throw new OpenAiAdapterError(
      "invalid_input",
      "transcription request identifiers and recording manifest must not be empty",
    );
  }

  const audioLocators = new Set<string>();
  for (const reference of request.recording.speakerAudio) {
    if (
      reference.audioLocator.trim().length === 0 ||
      reference.speakerId.trim().length === 0
    ) {
      throw new OpenAiAdapterError(
        "invalid_input",
        "speaker audio locator and speaker id must not be empty",
      );
    }
    if (!Number.isSafeInteger(reference.timelineOffsetMs) || reference.timelineOffsetMs < 0) {
      throw new OpenAiAdapterError(
        "invalid_input",
        "speaker audio timelineOffsetMs must be a non-negative safe integer",
      );
    }
    if (audioLocators.has(reference.audioLocator)) {
      throw new OpenAiAdapterError(
        "invalid_input",
        "speaker audio locators must be unique",
      );
    }
    audioLocators.add(reference.audioLocator);
  }
}

function validateAudioContent(audio: AudioContent): void {
  if (
    audio.fileName.trim().length === 0 ||
    audio.mediaType.trim().length === 0 ||
    audio.bytes.byteLength === 0
  ) {
    throw new OpenAiAdapterError(
      "invalid_input",
      "resolved audio bytes, fileName, and mediaType must not be empty",
    );
  }
  if (!supportedAudioExtension.test(audio.fileName)) {
    throw new OpenAiAdapterError(
      "invalid_input",
      "audio file extension is not supported by OpenAI transcription",
    );
  }
  if (audio.bytes.byteLength > maxOpenAiTranscriptionBytes) {
    throw new OpenAiAdapterError(
      "invalid_input",
      "resolved audio exceeds the OpenAI transcription limit of 25 MB",
    );
  }
}

function buildVocabularyPrompt(vocabulary: readonly string[] | undefined): string | undefined {
  if (vocabulary === undefined || vocabulary.length === 0) {
    return undefined;
  }
  const normalizedVocabulary = vocabulary.map((term) => term.trim());
  if (normalizedVocabulary.some((term) => term.length === 0)) {
    throw new OpenAiAdapterError("invalid_input", "vocabulary terms must not be empty");
  }

  const prompt = `Vocabulary: ${normalizedVocabulary.join(", ")}`;
  if (prompt.length > 4_000) {
    throw new OpenAiAdapterError("invalid_input", "vocabulary prompt exceeds 4000 characters");
  }
  return prompt;
}

function addMilliseconds(timelineOffsetMs: number, seconds: number): number {
  const relativeMs = Math.round(seconds * 1_000);
  const absoluteMs = timelineOffsetMs + relativeMs;
  if (!Number.isSafeInteger(relativeMs) || !Number.isSafeInteger(absoluteMs)) {
    throw new OpenAiAdapterError(
      "invalid_provider_response",
      "OpenAI returned a timestamp outside the supported range",
    );
  }
  return absoluteMs;
}

function compareProviderTurns(left: ProviderTranscriptTurn, right: ProviderTranscriptTurn): number {
  return (
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.speakerId.localeCompare(right.speakerId) ||
    left.sourceAudioIndex - right.sourceAudioIndex ||
    left.providerSegmentId.localeCompare(right.providerSegmentId)
  );
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  map: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      signal?.throwIfAborted();
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) {
        throw new OpenAiAdapterError("invalid_input", "missing speaker audio reference");
      }
      results[index] = await map(value, index);
      signal?.throwIfAborted();
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => worker()));
  return results;
}
