import {
  awaitWithinPlatformShutdownTimeout,
  defaultPlatformShutdownTimeoutMilliseconds,
} from "./shutdown-deadline.js";

type CloseStartedResource = () => Promise<void> | void;

interface StartedResource {
  readonly close: CloseStartedResource;
  readonly name: string;
}

/**
 * Owns only resources created while this process is starting. It is released
 * after a successful start, when the normal shutdown coordinator takes over.
 */
export class PlatformStartupCleanup {
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #released = false;
  #resources: StartedResource[] = [];

  public defer(name: string, close: CloseStartedResource): void {
    if (this.#released || this.#closing) {
      throw new Error("Cannot register a startup resource after startup completed");
    }
    this.#resources.push({ close, name });
  }

  public release(): void {
    this.#released = true;
    this.#resources = [];
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.closeStartedResources();
    return this.#closePromise;
  }

  private async closeStartedResources(): Promise<void> {
    this.#closing = true;
    const resources = this.#resources.toReversed();
    this.#resources = [];
    const failures: unknown[] = [];
    for (const resource of resources) {
      try {
        await this.closeResource(resource);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Meeting platform startup cleanup was incomplete",
      );
    }
  }

  private async closeResource(resource: StartedResource): Promise<void> {
    try {
      await awaitWithinPlatformShutdownTimeout(
        Promise.resolve().then(resource.close),
        defaultPlatformShutdownTimeoutMilliseconds,
      );
    } catch (error) {
      throw new Error(`Could not close started resource: ${resource.name}`, {
        cause: error,
      });
    }
  }
}

/** Preserves a failed startup's cause even when its reverse cleanup also fails. */
export async function rethrowAfterFailedPlatformStartup(
  startupFailure: unknown,
  cleanup: PlatformStartupCleanup,
): Promise<never> {
  try {
    await cleanup.close();
  } catch (cleanupFailure) {
    throw aggregateStartupAndCleanupFailures(startupFailure, cleanupFailure);
  }
  throw startupFailure;
}

function aggregateStartupAndCleanupFailures(
  startupFailure: unknown,
  cleanupFailure: unknown,
): AggregateError {
  return new AggregateError(
    [startupFailure, cleanupFailure],
    "Meeting platform startup failed and cleanup was incomplete",
    { cause: cleanupFailure },
  );
}
