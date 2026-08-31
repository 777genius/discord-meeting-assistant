import type {
  ClientConfig,
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from "pg";
import { Client } from "pg";

export interface HistoricalPostgresQuery {
  readonly text: string;
  readonly values?: readonly unknown[];
}

export interface HistoricalPostgresCancellationPort {
  cancelAndVerifyInactive(backendPid: number): Promise<void>;
}

export class HistoricalPostgresCancellationError extends Error {
  public override readonly name = "HistoricalPostgresCancellationError";

  public constructor(
    public readonly backendPid: number,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

interface BackendStateRow {
  readonly state: string | null;
}

interface CancellationRow {
  readonly accepted: boolean;
}

type HistoricalOperationOutcome<T> =
  | { readonly kind: "aborted" }
  | { readonly error: unknown; readonly kind: "failed" }
  | { readonly kind: "completed"; readonly value: T };

const defaultCancellationCleanupMs = 5_000;
const cancellationPollMs = 20;

/**
 * PostgreSQL cancellation has its own physical connection. It therefore still
 * works when the serving pool is saturated by the query being cancelled. The
 * same database role may cancel and terminate its own backend; failure to prove
 * that backend inactive is surfaced instead of being reported as a local abort.
 */
export class PgNativeHistoricalPostgresCancellation
  implements HistoricalPostgresCancellationPort
{
  readonly #cleanupMs: number;

  public constructor(
    private readonly pool: Pool,
    cleanupMs = defaultCancellationCleanupMs,
  ) {
    if (
      !Number.isSafeInteger(cleanupMs) ||
      cleanupMs < 500 ||
      cleanupMs > 30_000
    ) {
      throw new RangeError("historical PostgreSQL cancellation cleanup bound is invalid");
    }
    this.#cleanupMs = cleanupMs;
  }

  public async cancelAndVerifyInactive(backendPid: number): Promise<void> {
    requireBackendPid(backendPid);
    const startedAt = Date.now();
    const cancellationDeadline = startedAt + Math.floor(this.#cleanupMs / 2);
    const cleanupDeadline = startedAt + this.#cleanupMs;
    const client = new Client(cancellationClientConfig(this.pool, {
      application_name: "meeting-knowledge-historical-cancellation",
      connectionTimeoutMillis: this.#cleanupMs,
      query_timeout: this.#cleanupMs,
      statement_timeout: this.#cleanupMs,
    }));
    try {
      await withinCancellationDeadline((async () => {
        await client.connect();
        await client.query<CancellationRow>(
          "SELECT pg_cancel_backend($1)::boolean AS accepted",
          [backendPid],
        );
        if (await waitUntilBackendInactive(client, backendPid, cancellationDeadline)) {
          return;
        }
        await client.query<CancellationRow>(
          "SELECT pg_terminate_backend($1)::boolean AS accepted",
          [backendPid],
        );
        if (await waitUntilBackendInactive(client, backendPid, cleanupDeadline)) {
          return;
        }
        throw new HistoricalPostgresCancellationError(
          backendPid,
          "PostgreSQL backend remained active after bounded cancel and terminate",
        );
      })(), this.#cleanupMs, client);
    } catch (error) {
      if (error instanceof HistoricalPostgresCancellationError) {
        throw error;
      }
      throw new HistoricalPostgresCancellationError(
        backendPid,
        "PostgreSQL backend cancellation could not be verified",
        { cause: error },
      );
    } finally {
      await closeCancellationClient(client);
    }
  }
}

function cancellationClientConfig(
  pool: Pool,
  overrides: ClientConfig,
): ClientConfig {
  const poolOptions = pool.options;
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(poolOptions),
      ...Object.getOwnPropertyDescriptors(overrides),
    },
  );
}

/**
 * Historical reads use a dedicated serving client whenever cancellation is
 * available. Abort completion waits for the cancellation port to prove the
 * server backend inactive, then destroys the serving connection.
 */
export function queryHistoricalPostgres<Row extends QueryResultRow>(
  pool: Pool,
  query: HistoricalPostgresQuery,
  signal?: AbortSignal,
  cancellation?: HistoricalPostgresCancellationPort,
): Promise<QueryResult<Row>> {
  if (signal === undefined) {
    return pool.query<Row>(query.text, [...(query.values ?? [])]);
  }
  return withHistoricalPostgresClient(
    pool,
    signal,
    async (client) => await client.query<Row>(
      query.text,
      [...(query.values ?? [])],
    ),
    cancellation,
  );
}

export async function withHistoricalPostgresTransaction<T>(
  pool: Pool,
  signal: AbortSignal | undefined,
  operation: (client: PoolClient) => Promise<T>,
  cancellation?: HistoricalPostgresCancellationPort,
  begin = "BEGIN",
): Promise<T> {
  return withHistoricalPostgresClient(pool, signal, async (client) => {
    signal?.throwIfAborted();
    await client.query(begin);
    try {
      const result = await operation(client);
      signal?.throwIfAborted();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (signal?.aborted !== true) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the operation failure.
        }
      }
      signal?.throwIfAborted();
      throw error;
    }
  }, cancellation);
}

async function withHistoricalPostgresClient<T>(
  pool: Pool,
  signal: AbortSignal | undefined,
  operation: (client: PoolClient) => Promise<T>,
  cancellation?: HistoricalPostgresCancellationPort,
): Promise<T> {
  signal?.throwIfAborted();
  const client = await acquireHistoricalClient(pool, signal);
  const release = releaseClientOnce(client);
  let destroy = false;
  let backendPid: number | null = null;
  let resolveAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  signal?.addEventListener("abort", resolveAbort, { once: true });
  try {
    backendPid = signal === undefined ? null : postgresBackendPid(client);
    signal?.throwIfAborted();
    const operationOutcome: Promise<HistoricalOperationOutcome<T>> = operation(client).then(
      (value) => ({ kind: "completed" as const, value }),
      (error: unknown) => ({ error, kind: "failed" as const }),
    );
    const outcome = await awaitHistoricalOperation(operationOutcome, aborted, signal);
    if (outcome.kind === "aborted") {
      return await completeHistoricalAbort(pool, cancellation, backendPid, signal);
    }
    if (outcome.kind === "failed") {
      signal?.throwIfAborted();
      throw outcome.error;
    }
    signal?.throwIfAborted();
    return outcome.value;
  } catch (error) {
    destroy = signal?.aborted === true ||
      error instanceof HistoricalPostgresCancellationError;
    if (!(error instanceof HistoricalPostgresCancellationError)) {
      signal?.throwIfAborted();
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", resolveAbort);
    release(destroy || signal?.aborted === true);
  }
}

async function acquireHistoricalClient(
  pool: Pool,
  signal: AbortSignal | undefined,
): Promise<PoolClient> {
  return signal === undefined
    ? await pool.connect()
    : await acquireAbortableClient(pool, signal);
}

async function awaitHistoricalOperation<T>(
  operation: Promise<HistoricalOperationOutcome<T>>,
  aborted: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<HistoricalOperationOutcome<T>> {
  return signal === undefined
    ? await operation
    : await Promise.race([
        operation,
        aborted.then(() => ({ kind: "aborted" as const })),
      ]);
}

async function completeHistoricalAbort(
  pool: Pool,
  cancellation: HistoricalPostgresCancellationPort | undefined,
  backendPid: number | null,
  signal: AbortSignal | undefined,
): Promise<never> {
  if (backendPid === null) {
    throw new HistoricalPostgresCancellationError(
      -1,
      "cancelled PostgreSQL operation has no backend identity",
    );
  }
  const strategy = cancellation ?? new PgNativeHistoricalPostgresCancellation(pool);
  await strategy.cancelAndVerifyInactive(backendPid);
  signal?.throwIfAborted();
  throw new HistoricalPostgresCancellationError(
    backendPid,
    "PostgreSQL cancellation completed without the abort reason",
  );
}

function postgresBackendPid(client: PoolClient): number {
  const value = (client as PoolClient & { readonly processID?: unknown }).processID;
  if (typeof value !== "number") {
    throw new HistoricalPostgresCancellationError(
      -1,
      "node-postgres client did not expose its server backend identity",
    );
  }
  requireBackendPid(value);
  return value;
}

function requireBackendPid(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError("PostgreSQL backend identity is invalid");
  }
}

async function waitUntilBackendInactive(
  client: Client,
  backendPid: number,
  deadline: number,
): Promise<boolean> {
  for (;;) {
    const result = await client.query<BackendStateRow>(
      "SELECT state FROM pg_stat_activity WHERE pid = $1",
      [backendPid],
    );
    const row = result.rows[0];
    if (row === undefined || row.state !== "active") {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, cancellationPollMs);
    });
  }
}

async function withinCancellationDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  client: Client,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      client.connection.stream.destroy();
      reject(new Error("PostgreSQL cancellation cleanup exceeded its deadline"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function closeCancellationClient(client: Client): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const forceClose = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      client.connection.stream.destroy();
      resolve();
    }, 250);
  });
  await Promise.race([client.end().catch(() => {}), forceClose]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

async function acquireAbortableClient(
  pool: Pool,
  signal: AbortSignal,
): Promise<PoolClient> {
  const pending = pool.connect();
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (): void => {
    try {
      signal.throwIfAborted();
    } catch (error) {
      rejectAbort(error);
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([pending, aborted]);
  } catch (error) {
    void destroyClientWhenAcquired(pending);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function releaseClientOnce(client: PoolClient): (destroy?: boolean) => void {
  let released = false;
  return (destroy = false): void => {
    if (released) {
      return;
    }
    released = true;
    client.release(destroy);
  };
}

async function destroyClientWhenAcquired(pending: Promise<PoolClient>): Promise<void> {
  try {
    const client = await pending;
    client.release(true);
  } catch {
    // A failed acquisition owns no connection that needs releasing.
  }
}
