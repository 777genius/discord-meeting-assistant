interface CloseablePostgresPool {
  readonly end: () => Promise<void>;
  readonly off: (event: "remove", listener: () => void) => unknown;
  readonly on: (event: "remove", listener: () => void) => unknown;
  readonly totalCount: number;
}

// pg-pool removes idle clients from its internal list before their sockets emit
// "end", so Pool.end() can resolve while PostgreSQL connections are still open.
// Wait for every client observed at shutdown before stopping the disposable
// server, otherwise its SIGTERM becomes an unhandled client error in Vitest.
export async function closePostgresPool(poolToClose: CloseablePostgresPool): Promise<void> {
  const clientsAtShutdown = poolToClose.totalCount;
  if (clientsAtShutdown === 0) {
    await poolToClose.end();
    return;
  }

  let removedClients = 0;
  let resolveAllClientsRemoved: (() => void) | undefined;
  const allClientsRemoved = new Promise<void>((resolve) => {
    resolveAllClientsRemoved = resolve;
  });
  const onRemove = (): void => {
    removedClients += 1;
    if (removedClients === clientsAtShutdown) {
      resolveAllClientsRemoved?.();
    }
  };

  poolToClose.on("remove", onRemove);
  try {
    await poolToClose.end();
    await allClientsRemoved;
  } finally {
    poolToClose.off("remove", onRemove);
  }
}
