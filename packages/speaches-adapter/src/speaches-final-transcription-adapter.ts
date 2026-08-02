import type {
  FinalTranscriptionPort,
  FinalTranscriptionRequest,
  GeneratedTranscript,
  PortResult,
  SpeakerAudioReferenceSnapshot,
  TranscriptTurnSnapshot,
} from "@discord-meeting/meeting-core";

import type {
  BinaryAudioArtifact,
  BinaryAudioArtifactReader,
  BinaryAudioChunk,
} from "./binary-audio-artifact-reader.js";
import {
  SpeachesAdapterError,
  SpeachesClientError,
  toSpeachesPortFailure,
} from "./errors.js";
import type {
  SpeachesTranscriptionClient,
  SpeachesTranscriptionRequest,
} from "./speaches-transcription-client.js";

const supportedAudioExtension = /\.(?:flac|m4a|mp3|mp4|mpeg|mpga|ogg|wav|webm)$/iu;
const mebibyte = 1_024 * 1_024;

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

interface ValidatedOptions {
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

interface ResolvedSpeakerAudio {
  readonly artifact: BinaryAudioArtifact;
  readonly reference: SpeakerAudioReferenceSnapshot;
  readonly sourceAudioIndex: number;
}

interface ChunkTask {
  readonly chunk: BinaryAudioChunk;
  readonly chunkIndex: number;
  readonly reference: SpeakerAudioReferenceSnapshot;
  readonly sourceAudioIndex: number;
}

interface ProviderTranscriptTurn {
  readonly endMs: number;
  readonly providerSegmentId: string;
  readonly speakerId: string;
  readonly stableTurnId: string;
  readonly startMs: number;
  readonly text: string;
}

export class SpeachesFinalTranscriptionAdapter implements FinalTranscriptionPort {
  private readonly options: ValidatedOptions;

  public constructor(
    private readonly client: SpeachesTranscriptionClient,
    private readonly artifactReader: BinaryAudioArtifactReader,
    options: SpeachesFinalTranscriptionOptions,
  ) {
    this.options = validateOptions(options);
  }

  public async transcribe(
    request: CancellableFinalTranscriptionRequest,
  ): Promise<PortResult<GeneratedTranscript>> {
    try {
      return { ok: true, value: await this.transcribeOrThrow(request) };
    } catch (error: unknown) {
      if (request.signal?.aborted === true && !(error instanceof SpeachesAdapterError)) {
        return {
          ok: false,
          failure: toSpeachesPortFailure(
            new SpeachesAdapterError(
              "cancelled",
              "Speaches transcription was cancelled",
              true,
              { cause: error },
            ),
          ),
        };
      }
      return { ok: false, failure: toSpeachesPortFailure(error) };
    }
  }

  private async transcribeOrThrow(
    request: CancellableFinalTranscriptionRequest,
  ): Promise<GeneratedTranscript> {
    validateRequest(request, this.options.maxSpeakerTracks);
    request.signal?.throwIfAborted();

    const resolvedAudio = await mapWithConcurrency(
      request.recording.speakerAudio,
      this.options.maxConcurrency,
      request.signal,
      async (reference, sourceAudioIndex) =>
        this.readSpeakerAudio(reference, sourceAudioIndex, request.signal),
    );
    validateTotalAudioSize(resolvedAudio, this.options.maxTotalAudioBytes);

    const tasks = resolvedAudio.flatMap(({ artifact, reference, sourceAudioIndex }) =>
      artifact.chunks.map((chunk, chunkIndex): ChunkTask => ({
        chunk,
        chunkIndex,
        reference,
        sourceAudioIndex,
      })),
    );
    const chunkTurns = await mapWithConcurrency(
      tasks,
      this.options.maxConcurrency,
      request.signal,
      async (task) => this.transcribeChunk(task, request.idempotencyKey, request.signal),
    );
    const providerTurns = chunkTurns.flat().toSorted(compareProviderTurns);

    const turnIds = new Set(providerTurns.map(({ stableTurnId }) => stableTurnId));
    if (turnIds.size !== providerTurns.length) {
      throw new SpeachesAdapterError(
        "invalid_provider_response",
        "Speaches returned duplicate segment identities",
        false,
      );
    }

    return {
      transcriptId: stableId("transcript", request.idempotencyKey),
      version: 1,
      turns: providerTurns.map(
        (turn): TranscriptTurnSnapshot => ({
          endMs: turn.endMs,
          speakerId: turn.speakerId,
          startMs: turn.startMs,
          text: turn.text,
          turnId: turn.stableTurnId,
        }),
      ),
    };
  }

  private async readSpeakerAudio(
    reference: SpeakerAudioReferenceSnapshot,
    sourceAudioIndex: number,
    externalSignal: AbortSignal | undefined,
  ): Promise<ResolvedSpeakerAudio> {
    const timeoutSignal = AbortSignal.timeout(this.options.artifactReadTimeoutMs);
    const signal = combineSignals(externalSignal, timeoutSignal);

    let artifact: BinaryAudioArtifact;
    try {
      artifact = await this.artifactReader.read(reference.audioLocator, {
        maxChunkBytes: this.options.maxBytesPerChunk,
        maxChunks: this.options.maxChunksPerSpeaker,
        signal,
      });
    } catch (error: unknown) {
      throw classifyOperationError(
        error,
        externalSignal,
        timeoutSignal,
        "artifact_read_failed",
      );
    }

    validateArtifact(artifact, this.options);
    return { artifact, reference, sourceAudioIndex };
  }

  private async transcribeChunk(
    task: ChunkTask,
    idempotencyKey: string,
    externalSignal: AbortSignal | undefined,
  ): Promise<readonly ProviderTranscriptTurn[]> {
    const timeoutSignal = AbortSignal.timeout(this.options.providerRequestTimeoutMs);
    const signal = combineSignals(externalSignal, timeoutSignal);
    const providerRequest: SpeachesTranscriptionRequest = {
      audio: task.chunk.bytes,
      fileName: task.chunk.fileName,
      idempotencyKey: stableId(
        "transcription-request",
        idempotencyKey,
        String(task.sourceAudioIndex + 1),
        String(task.chunkIndex + 1),
      ),
      mediaType: task.chunk.mediaType,
      model: this.options.model,
      signal,
      ...(this.options.hotwords === undefined
        ? {}
        : { hotwords: this.options.hotwords }),
      ...(this.options.language === undefined
        ? {}
        : { language: this.options.language }),
      ...(this.options.prompt === undefined ? {} : { prompt: this.options.prompt }),
    };

    let response: unknown;
    try {
      response = await this.client.createTranscription(providerRequest);
    } catch (error: unknown) {
      const classified = classifyOperationError(
        error,
        externalSignal,
        timeoutSignal,
        "request_failed",
      );
      if (classified === error && error instanceof SpeachesClientError) {
        throw error;
      }
      throw classified;
    }

    return parseProviderTurns(response, task, idempotencyKey);
  }
}

function validateOptions(options: SpeachesFinalTranscriptionOptions): ValidatedOptions {
  const model = requireNonEmpty(options.model, "model");
  const language = optionalNonEmpty(options.language, "language");
  const maxConcurrency = integerOption(options.maxConcurrency, 2, 1, 16, "maxConcurrency");
  const maxSpeakerTracks = integerOption(
    options.maxSpeakerTracks,
    64,
    1,
    256,
    "maxSpeakerTracks",
  );
  const maxChunksPerSpeaker = integerOption(
    options.maxChunksPerSpeaker,
    128,
    1,
    1_024,
    "maxChunksPerSpeaker",
  );
  const maxBytesPerChunk = integerOption(
    options.maxBytesPerChunk,
    64 * mebibyte,
    1,
    512 * mebibyte,
    "maxBytesPerChunk",
  );
  const maxBytesPerSpeaker = integerOption(
    options.maxBytesPerSpeaker,
    512 * mebibyte,
    maxBytesPerChunk,
    4_096 * mebibyte,
    "maxBytesPerSpeaker",
  );
  const maxTotalAudioBytes = integerOption(
    options.maxTotalAudioBytes,
    2_048 * mebibyte,
    maxBytesPerSpeaker,
    8_192 * mebibyte,
    "maxTotalAudioBytes",
  );
  const artifactReadTimeoutMs = integerOption(
    options.artifactReadTimeoutMs,
    60_000,
    100,
    3_600_000,
    "artifactReadTimeoutMs",
  );
  const providerRequestTimeoutMs = integerOption(
    options.providerRequestTimeoutMs,
    900_000,
    100,
    3_600_000,
    "providerRequestTimeoutMs",
  );
  const vocabulary = normalizeVocabulary(options.vocabulary);

  return {
    artifactReadTimeoutMs,
    hotwords: vocabulary.length === 0 ? undefined : vocabulary.join(", "),
    language,
    maxBytesPerChunk,
    maxBytesPerSpeaker,
    maxChunksPerSpeaker,
    maxConcurrency,
    maxSpeakerTracks,
    maxTotalAudioBytes,
    model,
    prompt: undefined,
    providerRequestTimeoutMs,
  };
}

function validateRequest(
  request: FinalTranscriptionRequest,
  maxSpeakerTracks: number,
): void {
  requireNonEmpty(request.idempotencyKey, "idempotencyKey");
  requireNonEmpty(request.meetingId, "meetingId");
  requireNonEmpty(request.recording.recordingId, "recording.recordingId");
  requireNonEmpty(request.recording.manifestLocator, "recording.manifestLocator");
  if (request.recording.speakerAudio.length > maxSpeakerTracks) {
    throw new SpeachesAdapterError(
      "invalid_input",
      `recording exceeds the configured limit of ${maxSpeakerTracks} speaker tracks`,
      false,
    );
  }

  const locators = new Set<string>();
  for (const reference of request.recording.speakerAudio) {
    requireNonEmpty(reference.audioLocator, "speakerAudio.audioLocator");
    requireNonEmpty(reference.speakerId, "speakerAudio.speakerId");
    requireNonNegativeInteger(reference.timelineOffsetMs, "speakerAudio.timelineOffsetMs");
    if (locators.has(reference.audioLocator)) {
      throw new SpeachesAdapterError(
        "invalid_input",
        "speaker audio locators must be unique",
        false,
      );
    }
    locators.add(reference.audioLocator);
  }
}

function validateArtifact(
  artifact: BinaryAudioArtifact,
  options: ValidatedOptions,
): void {
  if (artifact.chunks.length === 0 || artifact.chunks.length > options.maxChunksPerSpeaker) {
    throw new SpeachesAdapterError(
      "invalid_input",
      `speaker audio must contain between 1 and ${options.maxChunksPerSpeaker} chunks`,
      false,
    );
  }

  let totalBytes = 0;
  let previousOffset = -1;
  for (const chunk of artifact.chunks) {
    requireNonEmpty(chunk.fileName, "audioChunk.fileName");
    requireNonEmpty(chunk.mediaType, "audioChunk.mediaType");
    requireNonNegativeInteger(chunk.timelineOffsetMs, "audioChunk.timelineOffsetMs");
    if (chunk.timelineOffsetMs <= previousOffset) {
      throw new SpeachesAdapterError(
        "invalid_input",
        "audio chunk timeline offsets must be strictly increasing",
        false,
      );
    }
    if (chunk.bytes.byteLength === 0 || chunk.bytes.byteLength > options.maxBytesPerChunk) {
      throw new SpeachesAdapterError(
        "invalid_input",
        `audio chunks must contain between 1 and ${options.maxBytesPerChunk} bytes`,
        false,
      );
    }
    if (!supportedAudioExtension.test(chunk.fileName)) {
      throw new SpeachesAdapterError(
        "invalid_input",
        "audio chunk file extension is not supported by Speaches",
        false,
      );
    }
    totalBytes += chunk.bytes.byteLength;
    previousOffset = chunk.timelineOffsetMs;
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes > options.maxBytesPerSpeaker) {
    throw new SpeachesAdapterError(
      "invalid_input",
      `speaker audio exceeds the configured limit of ${options.maxBytesPerSpeaker} bytes`,
      false,
    );
  }
}

function validateTotalAudioSize(
  resolvedAudio: readonly ResolvedSpeakerAudio[],
  maxTotalAudioBytes: number,
): void {
  const totalBytes = resolvedAudio.reduce(
    (sum, { artifact }) =>
      sum + artifact.chunks.reduce((chunkSum, chunk) => chunkSum + chunk.bytes.byteLength, 0),
    0,
  );
  if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalAudioBytes) {
    throw new SpeachesAdapterError(
      "invalid_input",
      `meeting audio exceeds the configured limit of ${maxTotalAudioBytes} bytes`,
      false,
    );
  }
}

function parseProviderTurns(
  response: unknown,
  task: ChunkTask,
  idempotencyKey: string,
): readonly ProviderTranscriptTurn[] {
  if (!isRecord(response) || typeof response.text !== "string") {
    throw invalidProviderResponse("Speaches verbose transcription is not an object");
  }
  if (response.segments === undefined) {
    if (response.text.trim().length === 0) {
      return [];
    }
    throw invalidProviderResponse(
      "Speaches returned transcript text without required segment timestamps",
    );
  }
  if (!Array.isArray(response.segments)) {
    throw invalidProviderResponse("Speaches transcription segments must be an array");
  }

  const segmentIds = new Set<string>();
  return response.segments.flatMap((segment): readonly ProviderTranscriptTurn[] => {
    if (
      !isRecord(segment) ||
      (typeof segment.id !== "number" && typeof segment.id !== "string") ||
      typeof segment.start !== "number" ||
      typeof segment.end !== "number" ||
      typeof segment.text !== "string"
    ) {
      throw invalidProviderResponse("Speaches returned an invalid transcript segment");
    }
    const providerSegmentId = String(segment.id).trim();
    if (providerSegmentId.length === 0 || segmentIds.has(providerSegmentId)) {
      throw invalidProviderResponse("Speaches returned duplicate or empty segment identities");
    }
    segmentIds.add(providerSegmentId);

    const text = segment.text.trim();
    if (text.length === 0) {
      return [];
    }
    if (
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end <= segment.start
    ) {
      throw invalidProviderResponse("Speaches returned an invalid segment time range");
    }

    const baseOffsetMs = addSafeIntegers(
      task.reference.timelineOffsetMs,
      task.chunk.timelineOffsetMs,
    );
    const startMs = addSafeIntegers(baseOffsetMs, secondsToMilliseconds(segment.start));
    const endMs = addSafeIntegers(baseOffsetMs, secondsToMilliseconds(segment.end));
    if (endMs <= startMs) {
      throw invalidProviderResponse(
        "Speaches segment duration is below millisecond precision",
      );
    }

    return [{
      endMs,
      providerSegmentId,
      speakerId: task.reference.speakerId,
      stableTurnId: stableId(
        "turn",
        idempotencyKey,
        String(task.sourceAudioIndex + 1),
        String(task.chunkIndex + 1),
        providerSegmentId,
      ),
      startMs,
      text,
    }];
  });
}

function classifyOperationError(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  fallbackCode: "artifact_read_failed" | "request_failed",
): unknown {
  if (externalSignal?.aborted === true) {
    return new SpeachesAdapterError(
      "cancelled",
      "Speaches transcription was cancelled",
      true,
      { cause: error },
    );
  }
  if (timeoutSignal.aborted) {
    return new SpeachesAdapterError(
      "timeout",
      fallbackCode === "artifact_read_failed"
        ? "Audio artifact read timed out"
        : "Speaches transcription request timed out",
      true,
      { cause: error },
    );
  }
  if (error instanceof SpeachesAdapterError || error instanceof SpeachesClientError) {
    return error;
  }
  return new SpeachesAdapterError(
    fallbackCode,
    fallbackCode === "artifact_read_failed"
      ? "Audio artifact could not be read"
      : "Speaches transcription request failed",
    true,
    { cause: error },
  );
}

function combineSignals(
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AbortSignal {
  return externalSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([externalSignal, timeoutSignal]);
}

function compareProviderTurns(left: ProviderTranscriptTurn, right: ProviderTranscriptTurn): number {
  return (
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.speakerId.localeCompare(right.speakerId) ||
    left.stableTurnId.localeCompare(right.stableTurnId)
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
        throw new SpeachesAdapterError(
          "invalid_input",
          "missing bounded-concurrency work item",
          false,
        );
      }
      results[index] = await map(value, index);
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => worker()));
  return results;
}

function normalizeVocabulary(vocabulary: readonly string[] | undefined): readonly string[] {
  if (vocabulary === undefined) {
    return [];
  }
  if (vocabulary.length > 256) {
    throw new SpeachesAdapterError(
      "invalid_input",
      "vocabulary cannot contain more than 256 terms",
      false,
    );
  }
  const normalized = [...new Set(vocabulary.map((term) => term.trim()))];
  if (normalized.some((term) => term.length === 0 || term.length > 128)) {
    throw new SpeachesAdapterError(
      "invalid_input",
      "vocabulary terms must contain between 1 and 128 characters",
      false,
    );
  }
  const hotwordsLength = normalized.join(", ").length;
  if (hotwordsLength > 4_096) {
    throw new SpeachesAdapterError(
      "invalid_input",
      "vocabulary hotwords cannot exceed 4096 characters",
      false,
    );
  }
  return normalized;
}

function integerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new SpeachesAdapterError(
      "invalid_input",
      `${field} must be an integer between ${minimum} and ${maximum}`,
      false,
    );
  }
  return candidate;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new SpeachesAdapterError(
      "invalid_input",
      `${field} must not be empty`,
      false,
    );
  }
  return normalized;
}

function optionalNonEmpty(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : requireNonEmpty(value, field);
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SpeachesAdapterError(
      "invalid_input",
      `${field} must be a non-negative safe integer`,
      false,
    );
  }
}

function secondsToMilliseconds(seconds: number): number {
  const milliseconds = Math.round(seconds * 1_000);
  if (!Number.isSafeInteger(milliseconds)) {
    throw invalidProviderResponse("Speaches returned a timestamp outside the supported range");
  }
  return milliseconds;
}

function addSafeIntegers(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw invalidProviderResponse("Speaches returned a timestamp outside the supported range");
  }
  return result;
}

function invalidProviderResponse(message: string): SpeachesAdapterError {
  return new SpeachesAdapterError("invalid_provider_response", message, false);
}

function stableId(kind: string, idempotencyKey: string, ...parts: readonly string[]): string {
  return [kind, "v1", encodeIdentityPart(idempotencyKey), ...parts.map(encodeIdentityPart)].join(":");
}

function encodeIdentityPart(value: string): string {
  return `${value.length}:${value}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
