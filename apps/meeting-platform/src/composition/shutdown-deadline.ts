export const defaultPlatformShutdownTimeoutMilliseconds = 15_000;

const maximumPlatformShutdownTimeoutMilliseconds = 60_000;

class PlatformShutdownTimeoutError extends Error {
  public constructor(timeoutMilliseconds: number) {
    super(
      `Meeting platform shutdown did not complete within ${String(timeoutMilliseconds)}ms`,
    );
    this.name = "PlatformShutdownTimeoutError";
  }
}

export function resolvePlatformShutdownTimeoutMilliseconds(
  value: number | undefined,
): number {
  const timeoutMilliseconds = value ?? defaultPlatformShutdownTimeoutMilliseconds;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > maximumPlatformShutdownTimeoutMilliseconds
  ) {
    throw new RangeError(
      `Platform shutdown timeout must be an integer from 1 through ${String(maximumPlatformShutdownTimeoutMilliseconds)}`,
    );
  }
  return timeoutMilliseconds;
}

export async function awaitWithinPlatformShutdownTimeout<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new PlatformShutdownTimeoutError(timeoutMilliseconds));
        }, timeoutMilliseconds);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
