const terminationSignals = ["SIGINT", "SIGTERM"] as const;

export async function withProcessAbortSignalScope<T>(
  reason: string,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort(new Error(reason));
  };
  for (const signal of terminationSignals) {
    process.once(signal, stop);
  }
  try {
    return await action(controller.signal);
  } finally {
    for (const signal of terminationSignals) {
      process.off(signal, stop);
    }
  }
}
