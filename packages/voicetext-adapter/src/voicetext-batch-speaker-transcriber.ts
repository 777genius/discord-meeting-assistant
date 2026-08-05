import { createHash } from "node:crypto";

import type { SpeakerAudioReferenceSnapshot } from "@discord-meeting/meeting-core";

import {
  validateVoicetextBatchArtifact,
  type CancellableVoicetextBatchTranscriptionRequest,
  type ValidatedVoicetextBatchFinalTranscriptionOptions,
} from "./voicetext-batch-final-transcription-configuration.js";
import { VoicetextAdapterError } from "./errors.js";
import type {
  CompleteOggArtifactReader,
  CompleteOggAudioArtifact,
} from "./ogg-artifact-reader.js";
import type {
  VoicetextBatchClient,
  VoicetextBatchTaskResult,
} from "./voicetext-batch-client.js";
import {
  addVoicetextBatchSafeIntegers,
  mapVoicetextBatchProviderTurns,
  stableVoicetextBatchIdempotencyKey,
  type VoicetextBatchProviderTurn,
} from "./voicetext-batch-final-transcription-turns.js";

const maximumRetryAfterMilliseconds = 3_600_000;

export interface VoicetextBatchPollingScheduler {
  nowMs(): number;

  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface VoicetextBatchSpeakerTranscriptionInput {
  readonly artifactFingerprints: AuthoritativeArtifactFingerprintBook;
  readonly externalSignal: AbortSignal;
  readonly reference: SpeakerAudioReferenceSnapshot;
  readonly request: CancellableVoicetextBatchTranscriptionRequest;
  readonly speakerIndex: number;
}

/**
 * Retains only checksums, so a retry can prove that it is re-uploading the
 * same authoritative object without retaining its complete bytes while a
 * batch job is being polled.
 */
export class AuthoritativeArtifactFingerprintBook {
  private readonly fingerprints = new Map<number, string>();

  public verify(speakerIndex: number, artifact: CompleteOggAudioArtifact): void {
    const fingerprint = createHash("sha256").update(artifact.bytes).digest("hex");
    const previous = this.fingerprints.get(speakerIndex);
    if (previous === undefined) {
      this.fingerprints.set(speakerIndex, fingerprint);
      return;
    }
    if (previous !== fingerprint) {
      throw new VoicetextAdapterError(
        "invalid_input",
        "authoritative speaker artifact changed while retrying",
        false,
      );
    }
  }
}

export const systemVoicetextBatchPollingScheduler: VoicetextBatchPollingScheduler = {
  nowMs: () => Date.now(),
  sleep: async (delayMs, signal) => {
    await sleepVoicetextBatchWithSignal(delayMs, signal);
  },
};

export class VoicetextBatchSpeakerTranscriber {
  public constructor(
    private readonly client: VoicetextBatchClient,
    private readonly artifactReader: CompleteOggArtifactReader,
    private readonly options: ValidatedVoicetextBatchFinalTranscriptionOptions,
    private readonly pollingScheduler: VoicetextBatchPollingScheduler,
  ) {}

  public async transcribe(
    input: VoicetextBatchSpeakerTranscriptionInput,
  ): Promise<readonly VoicetextBatchProviderTurn[]> {
    const idempotencyKey = stableVoicetextBatchIdempotencyKey(
      input.request.idempotencyKey,
      input.request.recording.recordingId,
      input.reference.speakerId,
    );
    const deadlineMs = addVoicetextBatchSafeIntegers(
      this.readPollingTime(),
      this.options.pollTimeoutMs,
    );
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
      const operation = createVoicetextBatchOperationSignal(input.externalSignal, remainingMs);
      let result: VoicetextBatchTaskResult;
      try {
        result = nextOperation.kind === "submit"
          ? await this.submitSpeakerArtifact({
              artifactFingerprints: input.artifactFingerprints,
              idempotencyKey,
              reference: input.reference,
              signal: operation.signal,
              speakerIndex: input.speakerIndex,
            })
          : await this.client.poll({ jobId: nextOperation.jobId, signal: operation.signal });
      } catch (error: unknown) {
        const classified = classifyVoicetextBatchOperationError(
          error,
          input.externalSignal,
          operation.timeoutSignal,
          "transport_error",
        );
        if (!isRetryableVoicetextBatchRequestFailure(classified)) {
          throw classified;
        }
        await this.waitForNextAttempt(
          pollVoicetextBatchDelay(classified.retryAfterMs ?? 0, attempts, this.options),
          deadlineMs,
          input.externalSignal,
        );
        continue;
      }
      if (result.kind === "completed") {
        return mapVoicetextBatchProviderTurns({
          idempotencyKey: input.request.idempotencyKey,
          options: this.options,
          reference: input.reference,
          result: result.result,
          speakerIndex: input.speakerIndex,
        });
      }
      if (result.kind === "failed") {
        throw new VoicetextAdapterError(
          "provider_error",
          "Voicetext batch transcription failed",
          result.retryable,
        );
      }

      await this.waitForNextAttempt(
        pollVoicetextBatchDelay(result.retryAfterMs, attempts, this.options),
        deadlineMs,
        input.externalSignal,
      );
      nextOperation = result.nextAction === "retry"
        ? { kind: "submit" }
        : { jobId: result.jobId, kind: "poll" };
    }
  }

  private async submitSpeakerArtifact(input: {
    readonly artifactFingerprints: AuthoritativeArtifactFingerprintBook;
    readonly idempotencyKey: string;
    readonly reference: SpeakerAudioReferenceSnapshot;
    readonly signal: AbortSignal;
    readonly speakerIndex: number;
  }): Promise<VoicetextBatchTaskResult> {
    const artifact = await this.readArtifact(input.reference, input.signal);
    input.artifactFingerprints.verify(input.speakerIndex, artifact);
    return await this.client.submit({
      audio: artifact.bytes,
      idempotencyKey: input.idempotencyKey,
      keyterms: this.options.keyterms,
      signal: input.signal,
    });
  }

  private async readArtifact(
    reference: SpeakerAudioReferenceSnapshot,
    externalSignal: AbortSignal | undefined,
  ): Promise<CompleteOggAudioArtifact> {
    const operation = createVoicetextBatchOperationSignal(
      externalSignal,
      this.options.artifactReadTimeoutMs,
    );
    try {
      const artifact = await awaitVoicetextBatchSignal(this.artifactReader.read(
        reference.audioLocator,
        {
          maxBytes: this.options.maxArtifactBytesPerSpeaker,
          signal: operation.signal,
        },
      ), operation.signal);
      validateVoicetextBatchArtifact(artifact, this.options.maxArtifactBytesPerSpeaker);
      return artifact;
    } catch (error: unknown) {
      throw classifyVoicetextBatchOperationError(
        error,
        externalSignal,
        operation.timeoutSignal,
        "artifact_read_failed",
      );
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
    const wait = createVoicetextBatchOperationSignal(externalSignal, remainingMs);
    try {
      await this.pollingScheduler.sleep(delayMs, wait.signal);
    } catch (error: unknown) {
      throw classifyVoicetextBatchOperationError(
        error,
        externalSignal,
        wait.timeoutSignal,
        "transport_error",
      );
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

function pollVoicetextBatchDelay(
  retryAfterMs: number,
  attempts: number,
  options: ValidatedVoicetextBatchFinalTranscriptionOptions,
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

function createVoicetextBatchOperationSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly timeoutSignal: AbortSignal } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: externalSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([externalSignal, timeoutSignal]),
    timeoutSignal,
  };
}

async function awaitVoicetextBatchSignal<Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  return await new Promise<Value>((resolve, reject) => {
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

async function sleepVoicetextBatchWithSignal(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
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

function classifyVoicetextBatchOperationError(
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
      "Voicetext " + fallbackCode.replaceAll("_", " ") + " timed out",
      true,
      { cause: error },
    );
  }
  if (error instanceof VoicetextAdapterError) {
    return error;
  }
  return new VoicetextAdapterError(
    fallbackCode,
    "Voicetext " + fallbackCode.replaceAll("_", " "),
    true,
    { cause: error },
  );
}

function isRetryableVoicetextBatchRequestFailure(
  error: unknown,
): error is VoicetextAdapterError {
  return error instanceof VoicetextAdapterError &&
    error.retryable &&
    (
      error.code === "rate_limited" ||
      error.code === "request_failed" ||
      error.code === "transport_error"
    );
}
