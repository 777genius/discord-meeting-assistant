import { createHash } from "node:crypto";

import type {
  FinalTranscriptionPort,
  FinalTranscriptionRequest,
  GeneratedTranscript,
  PortResult,
  SpeakerAudioReferenceSnapshot,
  TranscriptTurnSnapshot,
} from "@discord-meeting/meeting-core";

import {
  toVoicetextPortFailure,
  VoicetextAdapterError,
} from "./errors.js";
import type {
  CompleteOggArtifactReader,
  CompleteOggAudioArtifact,
} from "./ogg-artifact-reader.js";
import type {
  VoicetextBatchClient,
  VoicetextBatchTaskResult,
  VoicetextBatchTranscriptionResult,
} from "./voicetext-batch-client.js";

const mebibyte = 1_024 * 1_024;
const maximumRetryAfterMilliseconds = 3_600_000;
const maximumSegmentOverlapMilliseconds = 10_000;

export interface VoicetextBatchPollingScheduler {
  nowMs(): number;

  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface VoicetextBatchFinalTranscriptionOptions {
  readonly artifactReadTimeoutMs?: number;
  readonly keyterms?: readonly string[];
  readonly maxArtifactBytesPerSpeaker?: number;
  readonly maxConcurrency?: number;
  readonly maxPollAttempts?: number;
  readonly maxPollBackoffMs?: number;
  readonly maxSegmentOverlapMs?: number;
  readonly maxSegmentOverrunMs?: number;
  readonly maxSegmentsPerSpeaker?: number;
  readonly maxSpeakerTracks?: number;
  readonly maxTotalArtifactBytes?: number;
  readonly maxTranscriptCharsPerSegment?: number;
  readonly maxTranscriptCharsPerSpeaker?: number;
  readonly pollInitialBackoffMs?: number;
  readonly pollTimeoutMs?: number;
}

export type CancellableVoicetextBatchTranscriptionRequest = FinalTranscriptionRequest & {
  readonly signal?: AbortSignal;
};

interface ValidatedOptions {
  readonly artifactReadTimeoutMs: number;
  readonly keyterms: readonly string[];
  readonly maxArtifactBytesPerSpeaker: number;
  readonly maxConcurrency: number;
  readonly maxPollAttempts: number;
  readonly maxPollBackoffMs: number;
  readonly maxSegmentOverlapMs: number;
  readonly maxSegmentOverrunMs: number;
  readonly maxSegmentsPerSpeaker: number;
  readonly maxSpeakerTracks: number;
  readonly maxTotalArtifactBytes: number;
  readonly maxTranscriptCharsPerSegment: number;
  readonly maxTranscriptCharsPerSpeaker: number;
  readonly pollInitialBackoffMs: number;
  readonly pollTimeoutMs: number;
}

interface ProviderTurn {
  readonly endMs: number;
  readonly speakerId: string;
  readonly stableTurnId: string;
  readonly startMs: number;
  readonly text: string;
}

type SpeakerOutcome =
  | { readonly ok: true; readonly turns: readonly ProviderTurn[] }
  | { readonly error: unknown; readonly ok: false };

const systemVoicetextBatchPollingScheduler: VoicetextBatchPollingScheduler = {
  nowMs: () => Date.now(),
  sleep: async (delayMs, signal) => {
    await sleepWithSignal(delayMs, signal);
  },
};

/**
 * Final transcription adapter for the Voicetext-owned Deepgram batch-v2 API.
 * It owns artifact-to-evidence mapping while the injected client owns HTTP.
 */
export class VoicetextBatchFinalTranscriptionAdapter implements FinalTranscriptionPort {
  private readonly options: ValidatedOptions;

  public constructor(
    private readonly client: VoicetextBatchClient,
    private readonly artifactReader: CompleteOggArtifactReader,
    options: VoicetextBatchFinalTranscriptionOptions,
    private readonly pollingScheduler: VoicetextBatchPollingScheduler =
      systemVoicetextBatchPollingScheduler,
  ) {
    this.options = validateOptions(options);
  }

  public async transcribe(
    request: CancellableVoicetextBatchTranscriptionRequest,
  ): Promise<PortResult<GeneratedTranscript>> {
    try {
      return { ok: true, value: await this.transcribeOrThrow(request) };
    } catch (error: unknown) {
      if (request.signal?.aborted === true && !(error instanceof VoicetextAdapterError)) {
        return {
          failure: toVoicetextPortFailure(new VoicetextAdapterError(
            "cancelled",
            "Voicetext batch transcription was cancelled",
            true,
            { cause: error },
          )),
          ok: false,
        };
      }
      return { failure: toVoicetextPortFailure(error), ok: false };
    }
  }

  private async transcribeOrThrow(
    request: CancellableVoicetextBatchTranscriptionRequest,
  ): Promise<GeneratedTranscript> {
    validateRequest(request, this.options.maxSpeakerTracks);
    request.signal?.throwIfAborted();

    const failureAbort = new AbortController();
    const workSignal = request.signal === undefined
      ? failureAbort.signal
      : AbortSignal.any([request.signal, failureAbort.signal]);
    let totalArtifactBytes = 0;
    let firstFailure: { readonly error: unknown } | undefined;
    const outcomes = await mapWithConcurrency(
      request.recording.speakerAudio,
      this.options.maxConcurrency,
      workSignal,
      async (reference, speakerIndex): Promise<SpeakerOutcome> => {
        try {
          const artifact = await this.readArtifact(reference, workSignal);
          totalArtifactBytes = addBoundedBytes(
            totalArtifactBytes,
            artifact.bytes.byteLength,
            this.options.maxTotalArtifactBytes,
            "Authoritative Ogg audio",
          );
          return {
            ok: true,
            turns: await this.transcribeSpeaker(
              artifact,
              reference,
              speakerIndex,
              request,
              workSignal,
            ),
          };
        } catch (error: unknown) {
          if (firstFailure === undefined) {
            firstFailure = { error };
            failureAbort.abort(error);
          }
          return { error, ok: false };
        }
      },
    );
    if (firstFailure !== undefined) {
      throw firstFailure.error;
    }

    const turns = outcomes.flatMap((outcome) => outcome?.ok === true ? outcome.turns : [])
      .toSorted(compareTurns);
    if (new Set(turns.map(({ stableTurnId }) => stableTurnId)).size !== turns.length) {
      throw new VoicetextAdapterError(
        "invalid_provider_response",
        "Voicetext batch returned duplicate turn identities",
        false,
      );
    }
    return {
      transcriptId: stableId("transcript", request.idempotencyKey),
      turns: turns.map((turn): TranscriptTurnSnapshot => ({
        endMs: turn.endMs,
        speakerId: turn.speakerId,
        startMs: turn.startMs,
        text: turn.text,
        turnId: turn.stableTurnId,
      })),
      version: 1,
    };
  }

  private async readArtifact(
    reference: SpeakerAudioReferenceSnapshot,
    externalSignal: AbortSignal | undefined,
  ): Promise<CompleteOggAudioArtifact> {
    const operation = operationSignal(externalSignal, this.options.artifactReadTimeoutMs);
    try {
      const artifact = await awaitWithSignal(
        this.artifactReader.read(reference.audioLocator, {
          maxBytes: this.options.maxArtifactBytesPerSpeaker,
          signal: operation.signal,
        }),
        operation.signal,
      );
      validateArtifact(artifact, this.options.maxArtifactBytesPerSpeaker);
      return artifact;
    } catch (error: unknown) {
      throw classifyOperationError(error, externalSignal, operation.timeoutSignal, "artifact_read_failed");
    }
  }

  private async transcribeSpeaker(
    artifact: CompleteOggAudioArtifact,
    reference: SpeakerAudioReferenceSnapshot,
    speakerIndex: number,
    request: CancellableVoicetextBatchTranscriptionRequest,
    externalSignal: AbortSignal,
  ): Promise<readonly ProviderTurn[]> {
    const idempotencyKey = stableBatchIdempotencyKey(
      request.idempotencyKey,
      request.recording.recordingId,
      reference.speakerId,
    );
    const deadlineMs = addSafeIntegers(this.readPollingTime(), this.options.pollTimeoutMs);
    let attempts = 0;
    let nextOperation: { readonly kind: "submit" } | {
      readonly jobId: string;
      readonly kind: "poll";
    } = { kind: "submit" };

    for (;;) {
      attempts += 1;
      if (attempts > this.options.maxPollAttempts) {
        throw new VoicetextAdapterError(
          "timeout",
          "Voicetext batch polling exceeded the configured attempt limit",
          true,
        );
      }
      const remainingMs = deadlineMs - this.readPollingTime();
      if (remainingMs <= 0) {
        throw new VoicetextAdapterError(
          "timeout",
          "Voicetext batch transcription timed out",
          true,
        );
      }
      const operation = operationSignal(externalSignal, remainingMs);
      let result: VoicetextBatchTaskResult;
      try {
        result = nextOperation.kind === "submit"
          ? await this.client.submit({
              audio: artifact.bytes,
              idempotencyKey,
              keyterms: this.options.keyterms,
              signal: operation.signal,
            })
          : await this.client.poll({ jobId: nextOperation.jobId, signal: operation.signal });
      } catch (error: unknown) {
        const classified = classifyOperationError(
          error,
          externalSignal,
          operation.timeoutSignal,
          "transport_error",
        );
        if (!isRetryableBatchRequestFailure(classified)) {
          throw classified;
        }
        await this.waitForNextAttempt(
          pollDelay(classified.retryAfterMs ?? 0, attempts, this.options),
          deadlineMs,
          externalSignal,
        );
        continue;
      }
      if (result.kind === "completed") {
        return mapProviderTurns(
          result.result,
          reference,
          speakerIndex,
          request.idempotencyKey,
          this.options,
        );
      }
      if (result.kind === "failed") {
        throw new VoicetextAdapterError(
          "provider_error",
          "Voicetext batch transcription failed",
          result.retryable,
        );
      }

      await this.waitForNextAttempt(
        pollDelay(result.retryAfterMs, attempts, this.options),
        deadlineMs,
        externalSignal,
      );
      nextOperation = result.nextAction === "retry"
        ? { kind: "submit" }
        : { jobId: result.jobId, kind: "poll" };
    }
  }

  private async waitForNextAttempt(
    delayMs: number,
    deadlineMs: number,
    externalSignal: AbortSignal,
  ): Promise<void> {
    // Do not bind the sleep signal to the sleep duration itself: two timers
    // with the same deadline can race, turning every 202 into a timeout.
    // Re-read the shared deadline after a request and leave a real margin
    // between the delay and its cancellation timer.
    const remainingMs = deadlineMs - this.readPollingTime();
    if (remainingMs <= 0) {
      throw new VoicetextAdapterError(
        "timeout",
        "Voicetext batch transcription timed out",
        true,
      );
    }
    if (delayMs >= remainingMs) {
      throw new VoicetextAdapterError(
        "timeout",
        "Voicetext batch transcription timed out before its next poll",
        true,
      );
    }
    const wait = operationSignal(externalSignal, remainingMs);
    try {
      await this.pollingScheduler.sleep(delayMs, wait.signal);
    } catch (error: unknown) {
      throw classifyOperationError(error, externalSignal, wait.timeoutSignal, "transport_error");
    }
  }

  private readPollingTime(): number {
    const nowMs = this.pollingScheduler.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new VoicetextAdapterError(
        "invalid_input",
        "Voicetext batch polling clock returned an invalid time",
        false,
      );
    }
    return nowMs;
  }
}

function validateOptions(
  options: VoicetextBatchFinalTranscriptionOptions,
): ValidatedOptions {
  const maxArtifactBytesPerSpeaker = integerOption(
    options.maxArtifactBytesPerSpeaker,
    64 * mebibyte,
    27,
    64 * mebibyte,
    "maxArtifactBytesPerSpeaker",
  );
  return {
    artifactReadTimeoutMs: timeoutOption(
      options.artifactReadTimeoutMs,
      60_000,
      "artifactReadTimeoutMs",
    ),
    keyterms: normalizeKeyterms(options.keyterms),
    maxArtifactBytesPerSpeaker,
    // The batch backend admits two provider calls at once. Keeping this caller
    // bound aligned prevents an unbounded local submit queue from consuming
    // speaker artifacts before the backend can service them.
    maxConcurrency: integerOption(options.maxConcurrency, 2, 1, 2, "maxConcurrency"),
    maxPollAttempts: integerOption(options.maxPollAttempts, 128, 1, 1_024, "maxPollAttempts"),
    maxPollBackoffMs: integerOption(
      options.maxPollBackoffMs,
      10_000,
      100,
      60_000,
      "maxPollBackoffMs",
    ),
    maxSegmentOverlapMs: integerOption(
      options.maxSegmentOverlapMs,
      2_000,
      0,
      maximumSegmentOverlapMilliseconds,
      "maxSegmentOverlapMs",
    ),
    maxSegmentOverrunMs: integerOption(
      options.maxSegmentOverrunMs,
      2_000,
      0,
      60_000,
      "maxSegmentOverrunMs",
    ),
    maxSegmentsPerSpeaker: integerOption(
      options.maxSegmentsPerSpeaker,
      10_000,
      1,
      100_000,
      "maxSegmentsPerSpeaker",
    ),
    maxSpeakerTracks: integerOption(
      options.maxSpeakerTracks,
      64,
      1,
      256,
      "maxSpeakerTracks",
    ),
    maxTotalArtifactBytes: integerOption(
      options.maxTotalArtifactBytes,
      256 * mebibyte,
      maxArtifactBytesPerSpeaker,
      8_192 * mebibyte,
      "maxTotalArtifactBytes",
    ),
    maxTranscriptCharsPerSegment: integerOption(
      options.maxTranscriptCharsPerSegment,
      16_384,
      1,
      1_000_000,
      "maxTranscriptCharsPerSegment",
    ),
    maxTranscriptCharsPerSpeaker: integerOption(
      options.maxTranscriptCharsPerSpeaker,
      1_000_000,
      1,
      10_000_000,
      "maxTranscriptCharsPerSpeaker",
    ),
    pollInitialBackoffMs: integerOption(
      options.pollInitialBackoffMs,
      1_000,
      100,
      60_000,
      "pollInitialBackoffMs",
    ),
    pollTimeoutMs: timeoutOption(options.pollTimeoutMs, 900_000, "pollTimeoutMs"),
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
  if (
    request.recording.speakerAudio.length < 1 ||
    request.recording.speakerAudio.length > maxSpeakerTracks
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      `recording must contain between 1 and ${maxSpeakerTracks} speaker tracks`,
      false,
    );
  }
  const locators = new Set<string>();
  const speakers = new Set<string>();
  for (const reference of request.recording.speakerAudio) {
    requireNonEmpty(reference.audioLocator, "speakerAudio.audioLocator");
    requireNonEmpty(reference.speakerId, "speakerAudio.speakerId");
    requireNonNegativeInteger(reference.timelineOffsetMs, "speakerAudio.timelineOffsetMs");
    if (locators.has(reference.audioLocator) || speakers.has(reference.speakerId)) {
      throw new VoicetextAdapterError(
        "invalid_input",
        "speaker audio locators and speaker IDs must be unique",
        false,
      );
    }
    locators.add(reference.audioLocator);
    speakers.add(reference.speakerId);
  }
}

function validateArtifact(
  artifact: unknown,
  maxBytes: number,
): asserts artifact is CompleteOggAudioArtifact {
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    !("complete" in artifact) ||
    artifact.complete !== true ||
    !("container" in artifact) ||
    artifact.container !== "ogg" ||
    !("bytes" in artifact) ||
    !(artifact.bytes instanceof Uint8Array)
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "artifact reader must return one complete Ogg track",
      false,
    );
  }
  const bytes = artifact.bytes;
  if (
    bytes.byteLength < 27 ||
    bytes.byteLength > maxBytes ||
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "OggS" ||
    bytes[4] !== 0 ||
    bytes.byteLength < 27 + (bytes[26] ?? 0)
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "authoritative speaker artifact is not a bounded Ogg stream",
      false,
    );
  }
}

function mapProviderTurns(
  result: VoicetextBatchTranscriptionResult,
  reference: SpeakerAudioReferenceSnapshot,
  speakerIndex: number,
  idempotencyKey: string,
  options: ValidatedOptions,
): readonly ProviderTurn[] {
  const audioDurationMs = ceilingMilliseconds(result.durationSeconds);
  let previousEndMs = -1;
  let previousEndSeconds = -1;
  let totalCharacters = 0;
  const turns: ProviderTurn[] = [];
  for (const [utteranceIndex, utterance] of result.utterances.entries()) {
    if (utteranceIndex >= options.maxSegmentsPerSpeaker) {
      throw new VoicetextAdapterError(
        "limit_exceeded",
        "Voicetext batch returned too many final segments",
        false,
      );
    }
    const rawStartSeconds = utterance.startSeconds;
    const rawEndSeconds = utterance.endSeconds;
    const roundedStartMs = floorMilliseconds(rawStartSeconds);
    const relativeStartMs = Math.max(roundedStartMs, previousEndMs);
    const relativeEndMs = ceilingMilliseconds(utterance.endSeconds);
    if (
      rawEndSeconds <= rawStartSeconds ||
      exceedsSegmentOverlapLimit(
        previousEndSeconds,
        rawStartSeconds,
        options.maxSegmentOverlapMs,
      ) ||
      relativeEndMs <= relativeStartMs
    ) {
      throw new VoicetextAdapterError(
        "invalid_provider_response",
        "Voicetext batch final segments are overlapping or zero-length",
        false,
      );
    }
    if (relativeEndMs > addSafeIntegers(audioDurationMs, options.maxSegmentOverrunMs)) {
      throw new VoicetextAdapterError(
        "invalid_provider_response",
        "Voicetext batch final segment exceeds the speaker audio duration",
        false,
      );
    }
    previousEndMs = relativeEndMs;
    previousEndSeconds = rawEndSeconds;
    const text = utterance.transcript.trim();
    if (text.length === 0) {
      continue;
    }
    if (text.length > options.maxTranscriptCharsPerSegment) {
      throw new VoicetextAdapterError(
        "limit_exceeded",
        "Voicetext batch final segment exceeded its configured character limit",
        false,
      );
    }
    totalCharacters = addSafeIntegers(totalCharacters, text.length);
    if (totalCharacters > options.maxTranscriptCharsPerSpeaker) {
      throw new VoicetextAdapterError(
        "limit_exceeded",
        "Voicetext batch transcript exceeded its configured character limit",
        false,
      );
    }
    turns.push({
      endMs: addSafeIntegers(reference.timelineOffsetMs, relativeEndMs),
      speakerId: reference.speakerId,
      stableTurnId: stableId(
        "turn",
        idempotencyKey,
        String(speakerIndex + 1),
        String(utteranceIndex + 1),
      ),
      startMs: addSafeIntegers(reference.timelineOffsetMs, relativeStartMs),
      text,
    });
  }
  return turns;
}

function pollDelay(
  retryAfterMs: number,
  attempts: number,
  options: ValidatedOptions,
): number {
  const exponent = Math.min(attempts - 1, 6);
  const exponential = Math.min(
    options.maxPollBackoffMs,
    options.pollInitialBackoffMs * 2 ** exponent,
  );
  const validRetryAfterMs = Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
    ? retryAfterMs
    : 0;
  const advertised = Math.min(
    maximumRetryAfterMilliseconds,
    Math.max(options.pollInitialBackoffMs, validRetryAfterMs),
  );
  return Math.max(exponential, advertised);
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  signal: AbortSignal,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<readonly (Output | undefined)[]> {
  const results: Array<Output | undefined> = Array.from({ length: values.length });
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted) {
        return;
      }
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) {
        return;
      }
      const value = values[currentIndex];
      if (value === undefined) {
        throw new VoicetextAdapterError(
          "invalid_input",
          "missing bounded-concurrency work item",
          false,
        );
      }
      results[currentIndex] = await mapper(value, currentIndex);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()),
  );
  return results;
}

function operationSignal(externalSignal: AbortSignal | undefined, timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
} {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: externalSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([externalSignal, timeoutSignal]),
    timeoutSignal,
  };
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
        return value;
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
        return error;
      },
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

async function sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

function classifyOperationError(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  fallbackCode: "artifact_read_failed" | "transport_error",
): unknown {
  if (externalSignal?.aborted === true) {
    return new VoicetextAdapterError(
      "cancelled",
      "Voicetext batch transcription was cancelled",
      true,
      { cause: error },
    );
  }
  if (timeoutSignal.aborted) {
    return new VoicetextAdapterError(
      "timeout",
      `Voicetext ${fallbackCode.replaceAll("_", " ")} timed out`,
      true,
      { cause: error },
    );
  }
  if (error instanceof VoicetextAdapterError) {
    return error;
  }
  return new VoicetextAdapterError(
    fallbackCode,
    `Voicetext ${fallbackCode.replaceAll("_", " ")}`,
    true,
    { cause: error },
  );
}

function isRetryableBatchRequestFailure(error: unknown): error is VoicetextAdapterError {
  return error instanceof VoicetextAdapterError &&
    error.retryable &&
    (
      error.code === "rate_limited" ||
      error.code === "request_failed" ||
      error.code === "transport_error"
    );
}

function stableBatchIdempotencyKey(
  requestIdempotencyKey: string,
  recordingId: string,
  speakerId: string,
): string {
  return createHash("sha256")
    .update([
      "voicetext-batch-v2",
      identityPart(requestIdempotencyKey),
      identityPart(recordingId),
      identityPart(speakerId),
    ].join("|"), "utf8")
    .digest("hex");
}

function stableId(kind: string, idempotencyKey: string, ...parts: readonly string[]): string {
  return [kind, "v2", identityPart(idempotencyKey), ...parts.map(identityPart)].join(":");
}

function identityPart(value: string): string {
  return `${value.length}:${value}`;
}

function floorMilliseconds(value: number): number {
  const milliseconds = Math.floor(value * 1_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new VoicetextAdapterError(
      "invalid_provider_response",
      "Voicetext batch returned a timestamp outside the supported range",
      false,
    );
  }
  return milliseconds;
}

function ceilingMilliseconds(value: number): number {
  const milliseconds = Math.ceil(value * 1_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new VoicetextAdapterError(
      "invalid_provider_response",
      "Voicetext batch returned a timestamp outside the supported range",
      false,
    );
  }
  return milliseconds;
}

function exceedsSegmentOverlapLimit(
  previousEndSeconds: number,
  nextStartSeconds: number,
  maximumOverlapMilliseconds: number,
): boolean {
  const overlapSeconds = previousEndSeconds - nextStartSeconds;
  const maximumOverlapSeconds = maximumOverlapMilliseconds / 1_000;
  // JSON numbers can make a decimal boundary (for example 292.6 - 291.245)
  // infinitesimally larger than its intended provider value. The tolerance is
  // bounded to IEEE-754 representation error, not a semantic grace period.
  const representationTolerance = Number.EPSILON * Math.max(
    1,
    Math.abs(previousEndSeconds),
    Math.abs(nextStartSeconds),
  );
  return overlapSeconds > maximumOverlapSeconds + representationTolerance;
}

function compareTurns(left: ProviderTurn, right: ProviderTurn): number {
  return left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.speakerId.localeCompare(right.speakerId) ||
    left.stableTurnId.localeCompare(right.stableTurnId);
}

function addBoundedBytes(total: number, added: number, maximum: number, subject: string): number {
  const next = total + added;
  if (!Number.isSafeInteger(next) || next > maximum) {
    throw new VoicetextAdapterError(
      "limit_exceeded",
      `${subject} exceeded its configured total byte limit`,
      false,
    );
  }
  return next;
}

function addSafeIntegers(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new VoicetextAdapterError(
      "invalid_provider_response",
      "Voicetext batch returned a timestamp outside the supported range",
      false,
    );
  }
  return result;
}

function normalizeKeyterms(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) {
    return [];
  }
  if (values.length > 100) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "Voicetext batch keyterms exceed 100 values",
      false,
    );
  }
  if (values.some((value) => typeof value !== "string")) {
    throw new VoicetextAdapterError("invalid_input", "Voicetext batch keyterms are invalid", false);
  }
  const normalized = [...new Set(values.map((value) => value.trim()))].toSorted();
  if (normalized.some((value) => value.length === 0 || Buffer.byteLength(value, "utf8") > 200)) {
    throw new VoicetextAdapterError("invalid_input", "Voicetext batch keyterms are invalid", false);
  }
  return Object.freeze(normalized);
}

function timeoutOption(value: number | undefined, fallback: number, field: string): number {
  return integerOption(value, fallback, 100, 3_600_000, field);
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
    throw new VoicetextAdapterError(
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
    throw new VoicetextAdapterError("invalid_input", `${field} must not be empty`, false);
  }
  return normalized;
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VoicetextAdapterError(
      "invalid_input",
      `${field} must be a non-negative safe integer`,
      false,
    );
  }
}
