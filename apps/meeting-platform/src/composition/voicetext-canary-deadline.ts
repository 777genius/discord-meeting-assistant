export interface VoicetextCanaryDeadline {
  dispose(): void;
  readonly signal: AbortSignal;
}

export function createVoicetextCanaryDeadline(
  outerSignal: AbortSignal,
  deadlineMs: number,
): VoicetextCanaryDeadline {
  const controller = new AbortController();
  const abortFromOuter = () => {controller.abort(outerSignal.reason);};
  if (outerSignal.aborted) {abortFromOuter();}
  else {outerSignal.addEventListener("abort", abortFromOuter, { once: true });}
  const timeout = setTimeout(() => {
    controller.abort(new Error("Voicetext semantic canary exceeded its internal deadline"));
  }, deadlineMs);
  timeout.unref();
  return {
    dispose: () => {
      clearTimeout(timeout);
      outerSignal.removeEventListener("abort", abortFromOuter);
    },
    signal: controller.signal,
  };
}

export async function waitForVoicetextCanaryOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => {reject(signal.reason);};
    signal.addEventListener("abort", aborted, { once: true });
    void operation.then((value) => {
      signal.removeEventListener("abort", aborted);
      resolve(value);
      return null;
    }, (error: unknown) => {
      signal.removeEventListener("abort", aborted);
      reject(error);
      return null;
    });
  });
}
