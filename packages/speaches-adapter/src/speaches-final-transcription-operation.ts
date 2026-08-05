import { SpeachesAdapterError, SpeachesClientError } from "./errors.js";

export type SpeachesOperationFailureCode = "artifact_read_failed" | "request_failed";

export function combineSpeachesSignals(
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AbortSignal {
  return externalSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([externalSignal, timeoutSignal]);
}

export function classifySpeachesOperationError(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  fallbackCode: SpeachesOperationFailureCode,
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

export async function mapSpeachesWithConcurrency<Value, Result>(
  values: readonly Value[],
  concurrency: number,
  signal: AbortSignal | undefined,
  map: (value: Value, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
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
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
