import type {
  DependencyHealth,
  DependencyHealthSnapshot,
  HealthProbe,
  HealthProbeResult,
  HealthReporter,
  HealthSnapshot,
} from "./contracts.js";

export interface HealthAggregatorOptions {
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

interface InFlightHealthProbe {
  readonly controller: AbortController;
  readonly operation: Promise<HealthProbeResult>;
}

const HEALTH_STATUSES = new Set<DependencyHealth>([
  "degraded",
  "healthy",
  "unhealthy",
]);
const PROBE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const HEALTH_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 60_000;

function requireProbeName(name: string): string {
  if (!PROBE_NAME_PATTERN.test(name)) {
    throw new TypeError(
      "health probe name must be a bounded lowercase operational name",
    );
  }
  return name;
}

function requireTimeout(timeoutMs: number): number {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new RangeError("health timeoutMs must be an integer from 1 to 60000");
  }
  return timeoutMs;
}

function normalizeResult(result: HealthProbeResult): HealthProbeResult {
  if (!HEALTH_STATUSES.has(result.status)) {
    return Object.freeze({ code: "INVALID_RESULT", status: "unhealthy" });
  }
  if (result.code === undefined) {
    return Object.freeze({ status: result.status });
  }
  if (!HEALTH_CODE_PATTERN.test(result.code)) {
    return Object.freeze({ code: "INVALID_RESULT", status: "unhealthy" });
  }

  return Object.freeze({ code: result.code, status: result.status });
}

function failedResult(code: "CHECK_FAILED" | "CHECK_TIMEOUT"): HealthProbeResult {
  return Object.freeze({ code, status: "unhealthy" });
}

export class HealthAggregator implements HealthReporter {
  private readonly inFlight = new Map<string, InFlightHealthProbe>();
  private readonly now: () => Date;
  private readonly probes: readonly HealthProbe[];
  private readonly timeoutMs: number;

  public constructor(
    probes: readonly HealthProbe[],
    options: HealthAggregatorOptions = {},
  ) {
    const names = new Set<string>();
    this.probes = Object.freeze(
      [...probes]
        .map((probe) => {
          const name = requireProbeName(probe.name);
          if (names.has(name)) {
            throw new TypeError(`duplicate health probe name: ${name}`);
          }
          names.add(name);
          return Object.freeze({
            check: probe.check.bind(probe),
            critical: probe.critical,
            name,
          });
        })
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    );
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = requireTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  public async snapshot(): Promise<HealthSnapshot> {
    const checkedAt = this.now();
    if (Number.isNaN(checkedAt.getTime())) {
      throw new RangeError("health snapshot clock returned an invalid date");
    }

    const dependencies = Object.freeze(
      await Promise.all(this.probes.map((probe) => this.checkProbe(probe))),
    );
    const criticalFailure = dependencies.some(
      (dependency) => dependency.critical && dependency.status !== "healthy",
    );
    const anyFailure = dependencies.some(
      (dependency) => dependency.status !== "healthy",
    );

    return Object.freeze({
      checkedAt: checkedAt.toISOString(),
      dependencies,
      ready: !criticalFailure,
      status: criticalFailure
        ? "unhealthy"
        : anyFailure
          ? "degraded"
          : "healthy",
    });
  }

  private async checkProbe(probe: HealthProbe): Promise<DependencyHealthSnapshot> {
    const inFlight = this.inFlightProbe(probe);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<HealthProbeResult>((resolve) => {
      timeout = setTimeout(() => {
        inFlight.controller.abort();
        resolve(failedResult("CHECK_TIMEOUT"));
      }, this.timeoutMs);
      timeout.unref();
    });

    let result: HealthProbeResult;
    try {
      result = await Promise.race([inFlight.operation, timeoutResult]);
    } catch {
      result = failedResult("CHECK_FAILED");
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }

    return Object.freeze({
      ...normalizeResult(result),
      critical: probe.critical,
      name: probe.name,
    });
  }

  private inFlightProbe(probe: HealthProbe): InFlightHealthProbe {
    const existing = this.inFlight.get(probe.name);
    if (existing !== undefined) {
      return existing;
    }
    const controller = new AbortController();
    const operation = Promise.resolve()
      .then(async () => probe.check(controller.signal))
      .catch(() => failedResult("CHECK_FAILED"));
    const started = { controller, operation };
    this.inFlight.set(probe.name, started);
    void operation.then(() => {
      if (this.inFlight.get(probe.name) === started) {
        this.inFlight.delete(probe.name);
      }
      return null;
    });
    return started;
  }
}
