export async function startPreparedSidecar<Server>(input: {
  readonly disposePreparedRuntime: () => Promise<void>;
  readonly prepareRuntime: () => Promise<void>;
  readonly startServer: () => Promise<Server>;
}): Promise<Server> {
  try {
    await input.prepareRuntime();
    return await input.startServer();
  } catch (startupError: unknown) {
    await input.disposePreparedRuntime().catch(() => {});
    throw startupError;
  }
}
