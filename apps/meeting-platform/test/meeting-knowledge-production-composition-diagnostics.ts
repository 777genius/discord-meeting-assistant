import type { DisposableInfinityHttpService } from
  "@discord-meeting/infinity-context-adapter/test-support";
import type { FocusedMemoryReference } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { Meeting, type MeetingSnapshot } from
  "@discord-meeting/meeting-core/meeting-lifecycle";
import {
  PostgresHistoricalMemoryStore,
  type PostgresMeetingRepository,
} from "@discord-meeting/postgres-adapter";
import type { Pool } from "pg";
import { expect } from "vitest";

import {
  correctedHistoricalSnapshot,
  historicalMeetingId,
  historicalRows,
  requiredHistoricalRuntime,
} from "./meeting-knowledge-production-composition-fixtures.js";

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
  if (
    rawUrl === undefined || rawUrl === "" || consent === undefined || consent === ""
  ) {
    throw new Error(
      "external PostgreSQL qualification requires exact disposable consent",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("external PostgreSQL qualification URL is invalid");
  }
  if (
    !new Set(["postgres:", "postgresql:"]).has(parsed.protocol) ||
    parsed.search !== "" || parsed.hash !== ""
  ) {
    throw new Error("external PostgreSQL qualification URL is invalid");
  }
  if (!new Set(["127.0.0.1", "[::1]", "localhost"]).has(parsed.hostname)) {
    throw new Error("external PostgreSQL qualification must use a loopback host");
  }
  if (!/^\/meeting_knowledge_e2e_[a-z0-9_]{1,48}$/u.test(parsed.pathname)) {
    throw new Error(
      "external PostgreSQL qualification requires a dedicated database",
    );
  }
  if (consent !== parsed.pathname.slice(1)) {
    throw new Error(
      "external PostgreSQL qualification consent must name the exact database",
    );
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

export function focusedReferenceKey(reference: FocusedMemoryReference): string {
  return [
    reference.meetingId,
    reference.transcriptId,
    reference.transcriptVersion,
    reference.turnId,
    reference.turnHash,
  ].join("\u0000");
}

export async function assertPersistedCoverageAnalysis(
  pool: Pool,
  scopeId: string,
  roomId: string,
  signal: AbortSignal,
): Promise<number> {
  const plans = await new PostgresHistoricalMemoryStore(pool)
    .listCurrentRoomPlans(scopeId, roomId, 3, { signal });
  const slices = plans.flatMap(({ binding, plan }) =>
    plan.documents.flatMap(({ manifest }) => manifest.turnSources.map((source) => [
      binding.meetingId,
      binding.releaseId,
      source.sourceRef,
      source.sourceStartCodePoint,
      source.sourceEndCodePoint,
    ].join("\u0000")))
  );
  const uniqueSlices = new Set(slices);
  expect({
    duplicateOverlapSlices: slices.length - uniqueSlices.size,
    persistedSlices: slices.length,
    uniqueAuthorizedSlices: uniqueSlices.size,
  }).toEqual({
    duplicateOverlapSlices: 352,
    persistedSlices: 1_088,
    uniqueAuthorizedSlices: 736,
  });
  return uniqueSlices.size;
}

export async function waitForHistoricalRows(
  pool: Pool,
  predicate: (row: { readonly meeting_id: string; readonly state: string }) => boolean,
  expectedCount: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let rows = await historicalRows(pool);
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (rows.filter(predicate).length === expectedCount) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", aborted);
        resolve();
      }, 50);
      const aborted = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", aborted, { once: true });
    });
    rows = await historicalRows(pool);
  }
  throw new Error(
    `historical reconciliation did not settle: ${JSON.stringify(rows)}`,
  );
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
    const settled = work.then(() => null, () => null);
    await Promise.race([settled, cleanupBound]);
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

export function assertProviderWire(
  infinity: DisposableInfinityHttpService,
  forbiddenLocalIdentities: readonly string[],
): void {
  const paths = infinity.endpoint.requests.map(({ method, path }) =>
    `${method} ${path}`
  );
  expect(paths).toEqual(expect.arrayContaining([
    "GET /v1/capabilities",
    "POST /v1/documents",
    "POST /v1/search",
    "DELETE /v1/thread-memory",
    "POST /v1/thread-memory/status",
  ]));
  const wire = JSON.stringify(infinity.endpoint.requests);
  for (const identity of forbiddenLocalIdentities) {
    expect(wire).not.toContain(identity);
  }
}

export async function qualifySupersessionAndDeletion(
  pool: Pool,
  infinity: DisposableInfinityHttpService,
  repository: PostgresMeetingRepository,
  historical: MeetingSnapshot,
  signal: AbortSignal,
  hooks?: {
    readonly afterSupersession: () => Promise<void>;
    readonly beforeSupersession: () => Promise<void>;
  },
): Promise<void> {
  signal.throwIfAborted();
  await hooks?.beforeSupersession();
  signal.throwIfAborted();
  const corrected = correctedHistoricalSnapshot(historical);
  await repository.save(corrected, historical.revision);
  infinity.endpoint.loseNextDocumentDeleteResponse();
  const superseding = requiredHistoricalRuntime(pool, infinity, true, true);
  await superseding.assertReady();
  await superseding.start();
  try {
    await waitForHistoricalRows(
      pool,
      ({ meeting_id, state }) => meeting_id === historicalMeetingId &&
        (state === "applied" || state === "deleted"),
      2,
      signal,
    );
  } finally {
    await superseding.close();
  }
  const correctedText = infinity.endpoint.indexedTexts().join("\n");
  expect(correctedText).toContain("PINE-GOLF-V2");
  expect(correctedText).not.toMatch(/PINE-GOLF(?:\s|$)/u);
  const supersededRows = (await historicalRows(pool)).filter(({ meeting_id }) =>
    meeting_id === historicalMeetingId
  );
  expect(supersededRows.map(({ state }) => state).toSorted())
    .toEqual(["applied", "deleted"]);
  signal.throwIfAborted();
  await hooks?.afterSupersession();

  signal.throwIfAborted();
  if (corrected.transcript === null) {
    throw new Error("corrected shutdown fixture has no transcript");
  }
  const shutdownRevision = Meeting.restore({
    ...corrected,
    revision: corrected.revision + 1,
    transcript: {
      ...corrected.transcript,
      turns: corrected.transcript.turns.map((turn) =>
        turn.turnId === "history-turn-0719"
          ? { ...turn, text: "Correction PINE-GOLF-V3: shutdown cancellation must not index this text." }
          : turn
      ),
      version: 3,
    },
  }).toSnapshot();
  await repository.save(shutdownRevision, corrected.revision);
  const ingestGate = infinity.endpoint.pauseNextIngest();
  const cancelling = requiredHistoricalRuntime(pool, infinity, true, true);
  await cancelling.assertReady();
  const starting = cancelling.start();
  await ingestGate.started;
  const closeStarted = performance.now();
  await cancelling.close();
  await starting;
  expect(performance.now() - closeStarted).toBeLessThan(5_000);
  const rowsImmediatelyAfterClose = await pool.query<{
    readonly attempt_count: number;
    readonly state: string;
  }>(`
    SELECT attempt_count::integer AS attempt_count, state
    FROM meeting_core.historical_memory_sync
    WHERE meeting_id = $1 AND transcript_version = 3
  `, [historicalMeetingId]);
  expect(rowsImmediatelyAfterClose.rows).toEqual([{
    attempt_count: 1,
    state: "in_flight",
  }]);
  expect(infinity.endpoint.indexedTexts().join("\n")).not.toContain("PINE-GOLF-V3");
  ingestGate.resume();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  const rowsAfterLateProviderRelease = await pool.query<{
    readonly attempt_count: number;
    readonly state: string;
  }>(`
    SELECT attempt_count::integer AS attempt_count, state
    FROM meeting_core.historical_memory_sync
    WHERE meeting_id = $1 AND transcript_version = 3
  `, [historicalMeetingId]);
  expect(rowsAfterLateProviderRelease.rows).toEqual(rowsImmediatelyAfterClose.rows);
  expect(infinity.endpoint.indexedTexts().join("\n")).not.toContain("PINE-GOLF-V3");
  await pool.query(`
    UPDATE meeting_core.historical_memory_sync
    SET lease_expires_at = transaction_timestamp() - interval '1 millisecond'
    WHERE meeting_id = $1 AND transcript_version = 3
  `, [historicalMeetingId]);

  const deleting = requiredHistoricalRuntime(pool, infinity, false, false);
  expect(deleting.servingAuthorized()).toBe(false);
  expect(deleting.servingAuthorized()).toBe(false);
  await deleting.requestMeetingDeletion(historicalMeetingId);
  const deletionRowCount = (await historicalRows(pool)).filter(
    ({ meeting_id }) => meeting_id === historicalMeetingId,
  ).length;
  infinity.endpoint.loseNextThreadDeleteResponse();
  await deleting.start();
  try {
    await waitForHistoricalRows(
      pool,
      ({ meeting_id, state }) =>
        meeting_id === historicalMeetingId && state === "deleted",
      deletionRowCount,
      signal,
    );
  } finally {
    await deleting.close();
  }
  expect((await historicalRows(pool)).filter(({ meeting_id }) =>
    meeting_id === historicalMeetingId
  ).every(({ state }) => state === "deleted")).toBe(true);
  expect(infinity.endpoint.indexedTexts().join("\n"))
    .not.toContain("PINE-GOLF-V2");
  expect(infinity.endpoint.documentCount()).toBeGreaterThan(0);
}
