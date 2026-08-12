import { createHash } from "node:crypto";

interface ByteStreamReader {
  cancel(): Promise<void>;
  read(): Promise<unknown>;
  releaseLock(): void;
}

interface RecordingPlaybackHttpRequest<T> {
  readonly consume: (response: Response, signal: AbortSignal) => Promise<T>;
  readonly fetch: typeof fetch;
  readonly init: RequestInit;
  readonly timeoutMilliseconds: number;
  readonly url: URL;
}

export class RecordingPlaybackProbeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RecordingPlaybackProbeError";
  }
}

export function recordingPlaybackFailure(message: string): RecordingPlaybackProbeError {
  return new RecordingPlaybackProbeError(message);
}

export async function requestRecordingPlayback<T>(
  request: RecordingPlaybackHttpRequest<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(recordingPlaybackFailure("Recording playback request timed out"));
    }, request.timeoutMilliseconds);
    timeout.unref();
  });
  const operation = (async () => {
    const response = await request.fetch(request.url, {
      ...request.init,
      redirect: "error",
      signal: controller.signal,
    });
    return request.consume(response, controller.signal);
  })();
  try {
    return await Promise.race([operation, timedOut]);
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw recordingPlaybackFailure("Recording playback request timed out");
    }
    throw error instanceof RecordingPlaybackProbeError
      ? error
      : recordingPlaybackFailure("Recording playback HTTP request failed safely");
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function readRecordingPlaybackBody(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const byteLength = await consumeBody(response, signal, maximumBytes, (chunk) => {
    chunks.push(chunk);
  });
  return Buffer.concat(chunks, byteLength);
}

export async function hashRecordingPlaybackBody(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const hash = createHash("sha256");
  const byteLength = await consumeBody(response, signal, maximumBytes, (chunk) => {
    hash.update(chunk);
  });
  return { byteLength, sha256: hash.digest("hex") };
}

async function consumeBody(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
  consume: (chunk: Uint8Array) => void,
): Promise<number> {
  if (response.body === null) {
    throw recordingPlaybackFailure("Recording playback response has no body");
  }
  const reader: ByteStreamReader = response.body.getReader();
  let byteLength = 0;
  let reachedEnd = false;
  try {
    for (;;) {
      const chunk = await readChunk(reader, signal);
      if (chunk === null) {
        reachedEnd = true;
        break;
      }
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes) {
        throw recordingPlaybackFailure(
          "Recording playback response exceeded its authoritative size bound",
        );
      }
      consume(chunk);
    }
  } finally {
    if (!reachedEnd) {
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
  return byteLength;
}

async function readChunk(
  reader: ByteStreamReader,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const result = await abortableRead(reader, signal);
  if (typeof result !== "object" || result === null || !("done" in result)) {
    throw recordingPlaybackFailure("Recording playback response returned invalid bytes");
  }
  if (result.done === true) {
    return null;
  }
  const value = "value" in result ? result.value : undefined;
  if (result.done !== false || !(value instanceof Uint8Array)) {
    throw recordingPlaybackFailure("Recording playback response returned invalid bytes");
  }
  return value;
}

function abortableRead(reader: ByteStreamReader, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(recordingPlaybackFailure("Recording playback request timed out"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
        return null;
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        reject(recordingPlaybackFailure("Recording playback response body failed safely"));
        return null;
      },
    );
  });
}
