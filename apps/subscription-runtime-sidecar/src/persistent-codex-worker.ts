import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  PersistentCodexProcessRunnerOptions,
  PersistentCodexProfile,
  PersistentCodexWorkerPool,
  RuntimeWorkerJob,
  RuntimeWorkerModule,
  RuntimeWorkerPoolModule,
  RuntimeWorkerResult,
  RuntimeWorkerRunOptions,
} from "./persistent-codex-process-contracts.js";
import { requiredPersistentCodexEnvironment } from "./persistent-codex-request.js";
import type { SubscriptionRuntimeAccount } from "./subscription-account-pool.js";

export async function createPersistentCodexWorkerPool(
  options: PersistentCodexProcessRunnerOptions,
  profile: PersistentCodexProfile,
  environment: Readonly<Record<string, string>>,
  account: SubscriptionRuntimeAccount,
): Promise<PersistentCodexWorkerPool> {
  const encryptionKey = requiredPersistentCodexEnvironment(
    environment,
    "SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY",
  );
  const packageRoot = dirname(await realpath(options.packageManifestPath));
  const [runtime, workerCore] = await Promise.all([
    (options.workerModuleLoader ?? loadWorkerModule)(
      join(packageRoot, "dist/worker-codex/index.js"),
    ),
    (options.workerPoolModuleLoader ?? loadWorkerPoolModule)(
      join(packageRoot, "dist/worker-core/index.js"),
    ),
  ]);
  const sourceEnvironment = { ...environment };
  delete sourceEnvironment.SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY;
  delete sourceEnvironment.AGENT_RUNTIME_REASONING_EFFORT;
  const pool = new workerCore.BoundedSubscriptionWorkerPool({
    maxQueueSize: options.maximumQueuedTasks,
    poolId: [
      "discord-meeting",
      profile.execution.purpose.replaceAll(".", "-"),
      account.id,
    ].join("-"),
    prewarmOnStart: true,
    slots: options.maximumConcurrentTasksPerAccount,
    workerFactory: ({ workerId }) => new SeededRuntimeWorker(
      new runtime.FileBackendCodexWorker({
        cleanThreadPrewarm: true,
        codexBinaryPath: options.codexBinaryPath ?? "codex",
        encryptionKey,
        executionEngine: "app-server",
        executionProfile: "stateless-completion",
        model: profile.execution.model,
        outputSchemas: {
          [profile.execution.outputSchemaName]: profile.outputSchema,
        },
        providerInstanceId: account.providerInstanceId,
        reasoningEffort: profile.execution.reasoningEffort,
        sessionCacheSlots: 1,
        sourceEnv: sourceEnvironment,
        stateRootDir: options.stateRoot,
        taskTimeoutMs: 600_000,
        warmupPrompt: "Return exactly OK.",
        workerId,
        workspacePath: options.workspacePath,
      }),
      account.authJsonPath,
    ),
  });
  try {
    await pool.start();
    return { accountId: account.id, profile, pool };
  } catch (error: unknown) {
    await pool.dispose().catch(() => null);
    throw error;
  }
}

class SeededRuntimeWorker {
  public constructor(
    private readonly worker: InstanceType<RuntimeWorkerModule["FileBackendCodexWorker"]>,
    private readonly authJsonPath: string,
  ) {}

  public get state(): string {
    return this.worker.state;
  }

  public get workerId(): string {
    return this.worker.workerId;
  }

  public async start(): Promise<void> {
    await this.worker.start();
    await this.worker.seedCodexAuthJsonFile(this.authJsonPath);
  }

  public async prewarm(): Promise<unknown> {
    return await this.worker.prewarm();
  }

  public async run(
    input: RuntimeWorkerJob,
    options?: RuntimeWorkerRunOptions,
  ): Promise<RuntimeWorkerResult> {
    return await this.worker.run(input, options);
  }

  public async health(): Promise<unknown> {
    return await this.worker.health();
  }

  public async dispose(): Promise<void> {
    await this.worker.dispose();
  }
}

async function loadWorkerModule(path: string): Promise<RuntimeWorkerModule> {
  return await import(pathToFileURL(path).href) as RuntimeWorkerModule;
}

async function loadWorkerPoolModule(path: string): Promise<RuntimeWorkerPoolModule> {
  return await import(pathToFileURL(path).href) as RuntimeWorkerPoolModule;
}
