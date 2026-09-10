export async function startPreparedSidecar<Server>(input: {
  readonly disposePreparedRuntime: () => Promise<void>;
  readonly onPrepareFailure?: (error: unknown) => void;
  readonly prepareRuntime: () => Promise<void>;
  readonly startServer: () => Promise<Server>;
}): Promise<Server> {
  try {
    try {
      await input.prepareRuntime();
    } catch (prepareError: unknown) {
      if (input.onPrepareFailure === undefined) {
        throw prepareError;
      }
      input.onPrepareFailure(prepareError);
    }
    return await input.startServer();
  } catch (startupError: unknown) {
    await input.disposePreparedRuntime().catch(() => {});
    throw startupError;
  }
}
