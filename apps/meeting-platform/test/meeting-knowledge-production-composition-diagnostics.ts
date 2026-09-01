import type { Pool } from "pg";

import { historicalRows } from
  "./meeting-knowledge-production-composition-fixtures.js";

export interface QualificationStageTiming {
  readonly budgetMs: number;
  readonly durationMs: number;
  readonly stage: string;
}

const qualificationCleanupGraceMs = 5_000;

export function disposableExternalPostgresUrl(
  environment: Readonly<{
    readonly MEETING_KNOWLEDGE_E2E_DISPOSABLE_DATABASE?: string;
    readonly MEETING_KNOWLEDGE_E2E_POSTGRES_URL?: string;
  }>,
): string | undefined {
  const rawUrl = environment.MEETING_KNOWLEDGE_E2E_POSTGRES_URL?.trim();
  const consent = environment.MEETING_KNOWLEDGE_E2E_DISPOSABLE_DATABASE?.trim();
  if (rawUrl === undefined && consent === undefined) {
    return undefined;
  }
  if (rawUrl === undefined || rawUrl === "" || consent === undefined || consent === "") {
    throw new Error("external PostgreSQL qualification requires exact disposable consent");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("external PostgreSQL qualification URL is invalid");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) ||
    parsed.search !== "" || parsed.hash !== "") {
    throw new Error("external PostgreSQL qualification URL is invalid");
  }
  if (!new Set(["127.0.0.1", "[::1]", "localhost"]).has(parsed.hostname)) {
    throw new Error("external PostgreSQL qualification must use a loopback host");
  }
  if (!/^\/meeting_knowledge_e2e_[a-z0-9_]{1,48}$/u.test(parsed.pathname)) {
    throw new Error("external PostgreSQL qualification requires a dedicated database");
  }
  if (consent !== parsed.pathname.slice(1)) {
    throw new Error("external PostgreSQL qualification consent must name the exact database");
  }
  return rawUrl;
}

export function assertAggregateStageBudget(
  outerBudgetMs: number,
  stageBudgetsMs: readonly number[],
): void {
  const aggregate = stageBudgetsMs.reduce((total, budget) => total + budget, 0);
  if (aggregate >= outerBudgetMs) {
    throw new RangeError(
      `aggregate qualification stage budget ${aggregate}ms must be below outer budget ${outerBudgetMs}ms`,
    );
  }
}

export async function waitForHistoricalRows(
  pool: Pool,
  predicate: (row: { readonly meeting_id: string; readonly state: string }) => boolean,
  expectedCount: number,
  signal: AbortSignal,
  timeoutMilliseconds = 90_000,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 || timeoutMilliseconds > 120_000) {
    throw new RangeError("historical reconciliation timeout must be within 1..120000ms");
  }
  const deadline = Date.now() + timeoutMilliseconds;
  let rows = await historicalRows(pool);
  for (;;) {
    signal.throwIfAborted();
    if (rows.filter(predicate).length === expectedCount) {
      return;
    }
    const remainingMilliseconds = deadline - Date.now();
    if (remainingMilliseconds <= 0) {
      break;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", aborted);
        resolve();
      }, Math.min(50, remainingMilliseconds));
      const aborted = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", aborted, { once: true });
    });
    rows = await historicalRows(pool);
  }
  throw new Error(`historical reconciliation did not settle: ${JSON.stringify(rows)}`);
}

export async function runQualificationStage<T>(
  stage: string,
  budgetMs: number,
  timings: QualificationStageTiming[],
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `Meeting Knowledge qualification stage ${stage} exceeded its ${budgetMs}ms budget; completed=${JSON.stringify(timings)}`,
      ));
      controller.abort(new DOMException(
        `Meeting Knowledge qualification stage ${stage} timed out`,
        "TimeoutError",
      ));
    }, budgetMs);
  });
  const work = execute(controller.signal);
  try {
    const result = await Promise.race([work, timeout]);
    timings.push({
      budgetMs,
      durationMs: Math.ceil(performance.now() - started),
      stage,
    });
    return result;
  } catch (error) {
    controller.abort(error);
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupBound = new Promise<void>((resolve) => {
      cleanupTimer = setTimeout(resolve, qualificationCleanupGraceMs);
    });
    await Promise.race([work.then(() => null, () => null), cleanupBound]);
    if (cleanupTimer !== undefined) {
      clearTimeout(cleanupTimer);
    }
    throw new Error(
      `Meeting Knowledge qualification stage ${stage} failed after ${Math.ceil(performance.now() - started)}ms; completed=${JSON.stringify(timings)}`,
      { cause: error },
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
