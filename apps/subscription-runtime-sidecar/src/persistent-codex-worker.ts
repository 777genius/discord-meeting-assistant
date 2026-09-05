import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  PersistentCodexProcessRunnerOptions,
  PersistentCodexProfile,
  PersistentCodexWorkerGroup,
  RuntimeWorker,
  RuntimeWorkerGroup,
  RuntimeWorkerJob,
  RuntimeWorkerModule,
  RuntimeWorkerResult,
  RuntimeWorkerRunOptions,
} from "./persistent-codex-process-contracts.js";
import { requiredPersistentCodexEnvironment } from "./persistent-codex-request.js";
import type { SubscriptionRuntimeAccount } from "./subscription-account-pool.js";

type RuntimeWorkerFactory = (prewarm: boolean) => Promise<RuntimeWorker>;

export async function createPersistentCodexWorkerGroup(
  options: PersistentCodexProcessRunnerOptions,
  profile: PersistentCodexProfile,
  environment: Readonly<Record<string, string>>,
  account: SubscriptionRuntimeAccount,
): Promise<PersistentCodexWorkerGroup> {
  const encryptionKey = requiredPersistentCodexEnvironment(
    environment,
    "SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY",
  );
  const packageRoot = dirname(await realpath(options.packageManifestPath));
  const runtime = await (options.workerModuleLoader ?? loadWorkerModule)(
    join(packageRoot, "dist/worker-codex/index.js"),
  );
  const sourceEnvironment = { ...environment };
  delete sourceEnvironment.SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY;
  delete sourceEnvironment.AGENT_RUNTIME_REASONING_EFFORT;
  const groupId = [
    "discord-meeting",
    profile.execution.purpose.replaceAll(".", "-"),
    account.id,
  ].join("-");
  let workerSequence = 0;
  const group = new ElasticRuntimeWorkerGroup(async (prewarm) => {
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
      providerInstanceId: account.providerInstanceId,
      reasoningEffort: profile.execution.reasoningEffort,
      ...(profile.execution.serviceTier === undefined
        ? {}
        : { serviceTier: profile.execution.serviceTier }),
      sessionCacheSlots: 1,
      sourceEnv: sourceEnvironment,
      stateRootDir: options.stateRoot,
      taskTimeoutMs: 600_000,
      warmupPrompt: "Return exactly OK.",
      workerId: `${groupId}:worker-${++workerSequence}`,
      workspacePath: options.workspacePath,
    });
    try {
      await worker.start();
      await worker.seedCodexAuthJsonFile(account.authJsonPath);
      if (prewarm) {
        await worker.prewarm();
      }
      return worker;
    } catch (error: unknown) {
      await worker.dispose().catch(() => null);
      throw error;
    }
  });
  try {
    await group.start();
    return { accountId: account.id, profile, group };
  } catch (error: unknown) {
    await group.dispose();
    throw error;
  }
}

class ElasticRuntimeWorkerGroup implements RuntimeWorkerGroup {
  private readonly allWorkers = new Set<RuntimeWorker>();
  private readonly disposedWorkers = new WeakSet<RuntimeWorker>();
  private readonly pendingCreations = new Set<Promise<RuntimeWorker>>();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private retainedBusy = false;
  private retainedCreation: Promise<RuntimeWorker> | undefined;
  private retainedWorker: RuntimeWorker | undefined;

  public constructor(private readonly workerFactory: RuntimeWorkerFactory) {}

  public async start(): Promise<void> {
    this.assertAvailable();
    const retainedWorker = await this.createWorker(true);
    this.assertAvailable();
    this.retainedWorker = retainedWorker;
  }

  public async run(
    input: RuntimeWorkerJob,
    options?: RuntimeWorkerRunOptions,
  ): Promise<RuntimeWorkerResult> {
    this.assertAvailable();
    const retained = await this.takeRetainedWorker();
    if (retained !== undefined) {
      try {
        return await retained.run(input, options);
      } catch (error: unknown) {
        if (this.retainedWorker === retained) {
          this.retainedWorker = undefined;
        }
        await this.disposeWorker(retained);
        throw error;
      } finally {
        this.retainedBusy = false;
      }
    }

    const ephemeral = await this.createWorker(false);
    this.assertAvailable();
    try {
      return await ephemeral.run(input, options);
    } finally {
      await this.disposeWorker(ephemeral);
    }
  }

  public async dispose(): Promise<void> {
    this.disposePromise ??= this.disposeAll();
    await this.disposePromise;
  }

  private async disposeAll(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled(this.pendingCreations);
    this.retainedWorker = undefined;
    await Promise.allSettled(
      [...this.allWorkers].map(async (worker) => this.disposeWorker(worker)),
    );
  }

  private async takeRetainedWorker(): Promise<RuntimeWorker | undefined> {
    if (this.retainedBusy) {
      return undefined;
    }
    if (this.retainedWorker === undefined) {
      if (this.retainedCreation !== undefined) {
        return undefined;
      }
      const creation = this.createWorker(true);
      this.retainedCreation = creation;
      try {
        const retainedWorker = await creation;
        this.assertAvailable();
        this.retainedWorker = retainedWorker;
      } finally {
        if (this.retainedCreation === creation) {
          this.retainedCreation = undefined;
        }
      }
    }
    this.retainedBusy = true;
    return this.retainedWorker;
  }

  private async createWorker(prewarm: boolean): Promise<RuntimeWorker> {
    this.assertAvailable();
    const creation = this.workerFactory(prewarm).then((worker) => {
      this.allWorkers.add(worker);
      return worker;
    });
    this.pendingCreations.add(creation);
    try {
      return await creation;
    } finally {
      this.pendingCreations.delete(creation);
    }
  }

  private async disposeWorker(worker: RuntimeWorker): Promise<void> {
    if (this.disposedWorkers.has(worker)) {
      return;
    }
    this.disposedWorkers.add(worker);
    await worker.dispose().catch(() => null);
    this.allWorkers.delete(worker);
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw workerGroupDisposed();
    }
  }
}

async function loadWorkerModule(path: string): Promise<RuntimeWorkerModule> {
  return await import(pathToFileURL(path).href) as RuntimeWorkerModule;
}

function workerGroupDisposed(): Error {
  return new Error("Persistent Codex worker group is disposed");
}
