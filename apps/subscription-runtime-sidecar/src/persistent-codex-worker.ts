import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  PersistentCodexProcessRunnerOptions,
  PersistentCodexProfile,
  PersistentCodexWorkerSlot,
  RuntimeWorkerModule,
} from "./persistent-codex-process-contracts.js";
import { requiredPersistentCodexEnvironment } from "./persistent-codex-request.js";

export async function createPersistentCodexWorkerSlot(
  options: PersistentCodexProcessRunnerOptions,
  profile: PersistentCodexProfile,
  environment: Readonly<Record<string, string>>,
): Promise<PersistentCodexWorkerSlot> {
  const encryptionKey = requiredPersistentCodexEnvironment(
    environment,
    "SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY",
  );
  const modulePath = join(
    dirname(await realpath(options.packageManifestPath)),
    "dist/worker-codex/index.js",
  );
  const runtime = await (options.workerModuleLoader ?? loadWorkerModule)(modulePath);
  const sourceEnvironment = { ...environment };
  delete sourceEnvironment.SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY;
  delete sourceEnvironment.AGENT_RUNTIME_REASONING_EFFORT;
  const worker = new runtime.FileBackendCodexWorker({
    cleanThreadPrewarm: true,
    codexBinaryPath: options.codexBinaryPath ?? "codex",
    encryptionKey,
    executionEngine: "app-server",
    executionProfile: "stateless-completion",
    model: profile.execution.model,
    outputSchemas: {
      [profile.execution.outputSchemaName]: profile.outputSchema,
    },
    providerInstanceId: options.providerInstanceId,
    reasoningEffort: profile.execution.reasoningEffort,
    sessionCacheSlots: 1,
    sourceEnv: sourceEnvironment,
    stateRootDir: options.stateRoot,
    taskTimeoutMs: 600_000,
    warmupPrompt: "Return exactly OK.",
    workerId: `discord-meeting-${profile.execution.purpose.replaceAll(".", "-")}`,
    workspacePath: options.workspacePath,
  });
  await worker.start();
  try {
    await worker.seedCodexAuthJsonFile(options.authJsonPath);
    await worker.prewarm();
    return { profile, worker };
  } catch (error: unknown) {
    await worker.dispose().catch(() => null);
    throw error;
  }
}

async function loadWorkerModule(path: string): Promise<RuntimeWorkerModule> {
  return await import(pathToFileURL(path).href) as RuntimeWorkerModule;
}
