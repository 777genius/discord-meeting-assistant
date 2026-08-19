import { describe, expect, it, vi } from "vitest";

const cancellationClientConstructions = vi.hoisted(() => ({
  configurations: [] as unknown[],
}));

vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();
  return {
    ...actual,
    Client: class {
      public readonly connection = {
        stream: { destroy: () => {} },
      };

      public constructor(configuration: unknown) {
        cancellationClientConstructions.configurations.push(configuration);
      }

      public async connect(): Promise<void> {}

      public async end(): Promise<void> {}

      public async query(): Promise<{ readonly rows: readonly [] }> {
        return { rows: [] };
      }
    },
  };
});

import {
  createHistoricalReleaseBinding,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  HistoricalPostgresCancellationError,
  PgNativeHistoricalPostgresCancellation,
  PostgresExhaustiveCoverageStore,
  PostgresHistoricalEvidenceAuthority,
  PostgresHistoricalMemoryStore,
  type HistoricalPostgresCancellationPort,
} from "@discord-meeting/postgres-adapter";
import type {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from "pg";

function emptyResult<Row extends QueryResultRow>(): QueryResult<Row> {
  return {
    command: "SELECT",
    fields: [],
    oid: 0,
    rowCount: 0,
    rows: [],
  };
}

function pendingClient() {
  let rejectQuery: ((reason?: unknown) => void) | undefined;
  const queryStarted = Promise.withResolvers<void>();
  const release = vi.fn((destroy?: boolean) => {
    if (destroy === true) {
      rejectQuery?.(new Error("synthetic PostgreSQL connection destroyed"));
    }
  });
  const query = vi.fn(() => {
    queryStarted.resolve();
    return new Promise<QueryResult<QueryResultRow>>((_resolve, reject) => {
      rejectQuery = reject;
    });
  });
  const client = {
    processID: 42_424,
    query,
    release,
  } as unknown as PoolClient;
  return {
    cancelServerWork: () => {
      rejectQuery?.(new Error("synthetic PostgreSQL query cancelled by server"));
    },
    client,
    query,
    queryStarted: queryStarted.promise,
    release,
  };
}

function cancellationFor(
  fixture: ReturnType<typeof pendingClient>,
): HistoricalPostgresCancellationPort & {
  readonly cancelAndVerifyInactive: ReturnType<typeof vi.fn>;
} {
  return {
    cancelAndVerifyInactive: vi.fn(async (backendPid: number) => {
      expect(backendPid).toBe(42_424);
      fixture.cancelServerWork();
    }),
  };
}

function poolWithClient(client: PoolClient): Pool {
  return {
    connect: vi.fn(() => Promise.resolve(client)),
  } as unknown as Pool;
}

const binding = createHistoricalReleaseBinding({
  acceptedMeetingRevision: 3,
  desiredGeneration: 1,
  meetingId: "synthetic-meeting",
  roomId: "synthetic-room",
  scopeId: "synthetic-scope",
  transcriptId: "synthetic-transcript",
  transcriptVersion: 1,
});

describe("historical PostgreSQL cancellation", () => {
  it("preserves non-enumerable pool credentials for the cancellation connection", async () => {
    cancellationClientConstructions.configurations.length = 0;
    const ssl = { rejectUnauthorized: true };
    const options = {
      database: "synthetic_database",
      host: "synthetic-host",
      port: 5432,
      user: "synthetic_user",
    };
    Object.defineProperties(options, {
      password: { value: "synthetic_password" },
      ssl: { value: ssl },
    });
    const pool = { options } as unknown as Pool;

    await new PgNativeHistoricalPostgresCancellation(pool, 500)
      .cancelAndVerifyInactive(42_424);

    const configuration = cancellationClientConstructions.configurations[0] as Record<
      PropertyKey,
      unknown
    >;
    expect(configuration).toBeDefined();
    expect(configuration.password).toBe("synthetic_password");
    expect(configuration.ssl).toBe(ssl);
    expect(configuration.application_name).toBe(
      "meeting-knowledge-historical-cancellation",
    );
    expect(Object.getOwnPropertyDescriptor(configuration, "password")?.enumerable).toBe(false);
  });

  it("does not surface the abort reason before server inactivity is verified", async () => {
    const fixture = pendingClient();
    const verification = Promise.withResolvers<void>();
    const cancelAndVerifyInactive = vi.fn(async () => {
      fixture.cancelServerWork();
      await verification.promise;
    });
    const serverCancellation: HistoricalPostgresCancellationPort = {
      cancelAndVerifyInactive,
    };
    const authority = new PostgresHistoricalEvidenceAuthority(
      poolWithClient(fixture.client),
      serverCancellation,
    );
    const controller = new AbortController();
    const abortReason = new Error("synthetic verified cancellation");
    const operation = authority.loadAcceptedFinalMeeting(binding, {
      signal: controller.signal,
    });
    let settled = false;
    void operation.then(
      () => {
        settled = true;
        return settled;
      },
      () => {
        settled = true;
        return settled;
      },
    );
    await fixture.queryStarted;

    controller.abort(abortReason);
    await vi.waitFor(() => {
      expect(cancelAndVerifyInactive).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);

    verification.resolve();
    await expect(operation).rejects.toBe(abortReason);
    expect(fixture.release).toHaveBeenCalledWith(true);
  });

  it("destroys the dedicated authority connection when an in-flight read is aborted", async () => {
    const fixture = pendingClient();
    const serverCancellation = cancellationFor(fixture);
    const authority = new PostgresHistoricalEvidenceAuthority(
      poolWithClient(fixture.client),
      serverCancellation,
    );
    const controller = new AbortController();
    const abortReason = new Error("synthetic barge-in");
    const operation = authority.loadAcceptedFinalMeeting(binding, {
      signal: controller.signal,
    });
    await fixture.queryStarted;

    controller.abort(abortReason);

    await expect(operation).rejects.toBe(abortReason);
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledWith(true);
    expect(serverCancellation.cancelAndVerifyInactive).toHaveBeenCalledOnce();
  });

  it("destroys the dedicated historical state connection on participant departure", async () => {
    const fixture = pendingClient();
    const serverCancellation = cancellationFor(fixture);
    const store = new PostgresHistoricalMemoryStore(
      poolWithClient(fixture.client),
      serverCancellation,
    );
    const controller = new AbortController();
    const abortReason = new Error("synthetic participant departure");
    const operation = store.listDesiredRoomBindings(
      binding.scopeId,
      binding.roomId,
      10,
      { signal: controller.signal },
    );
    await fixture.queryStarted;

    controller.abort(abortReason);

    await expect(operation).rejects.toBe(abortReason);
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledWith(true);
    expect(serverCancellation.cancelAndVerifyInactive).toHaveBeenCalledOnce();
  });

  it("cancels coverage checkpoint writes instead of leaving a pending query", async () => {
    const fixture = pendingClient();
    const serverCancellation = cancellationFor(fixture);
    const checkpoints = new PostgresExhaustiveCoverageStore(
      poolWithClient(fixture.client),
      serverCancellation,
    );
    const controller = new AbortController();
    const abortReason = new Error("synthetic request cancellation");
    const operation = checkpoints.complete({
      checkpointId: "checkpoint-1",
      fence: 1,
      signal: controller.signal,
    });
    await fixture.queryStarted;

    controller.abort(abortReason);

    await expect(operation).rejects.toBe(abortReason);
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledWith(true);
    expect(serverCancellation.cancelAndVerifyInactive).toHaveBeenCalledOnce();
  });

  it("destroys a connection that arrives after cancellation wins acquisition", async () => {
    const acquired = Promise.withResolvers<PoolClient>();
    const fixture = pendingClient();
    const pool = {
      connect: vi.fn(() => acquired.promise),
      query: vi.fn(() => Promise.resolve(emptyResult())),
    } as unknown as Pool;
    const authority = new PostgresHistoricalEvidenceAuthority(pool);
    const controller = new AbortController();
    const cancellation = new Error("synthetic cancellation while acquiring");
    const operation = authority.loadAcceptedFinalMeeting(binding, {
      signal: controller.signal,
    });

    controller.abort(cancellation);
    await expect(operation).rejects.toBe(cancellation);
    acquired.resolve(fixture.client);
    await vi.waitFor(() => {
      expect(fixture.release).toHaveBeenCalledWith(true);
    });
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it("fails closed when server-side cancellation cannot be verified", async () => {
    const fixture = pendingClient();
    const cancellationFailure = new HistoricalPostgresCancellationError(
      42_424,
      "synthetic server cancellation could not be verified",
    );
    const authority = new PostgresHistoricalEvidenceAuthority(
      poolWithClient(fixture.client),
      {
        cancelAndVerifyInactive: async () => {
          throw cancellationFailure;
        },
      },
    );
    const controller = new AbortController();
    const operation = authority.loadAcceptedFinalMeeting(binding, {
      signal: controller.signal,
    });
    await fixture.queryStarted;

    controller.abort(new Error("synthetic local cancellation"));

    await expect(operation).rejects.toBe(cancellationFailure);
    expect(fixture.release).toHaveBeenCalledWith(true);
  });
});
