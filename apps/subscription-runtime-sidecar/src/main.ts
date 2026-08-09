import { readFile } from "node:fs/promises";

import {
  conversationAnswerExecutionProfile,
  providerConversationAnswerJsonSchema,
} from "@discord-meeting/subscription-runtime-adapter";

import { startGrpcServer } from "./grpc-server.js";
import { FileInstallationInspector } from "./installation-inspector.js";
import { NodeProcessRunner } from "./node-process-runner.js";
import { PersistentCodexProcessRunner } from "./persistent-codex-process-runner.js";
import { FileRuntimeReadinessInspector } from "./runtime-readiness.js";
import { resolveSidecarSettings } from "./settings.js";
import { startPreparedSidecar } from "./sidecar-startup.js";
import { SubscriptionAccountPool } from "./subscription-account-pool.js";
import {
  buildChildEnvironment,
  SubscriptionRuntimeExecutor,
} from "./subscription-runtime-executor.js";

async function bootstrap(): Promise<void> {
  const settings = await resolveSidecarSettings(process.env);
  const accountPool = new SubscriptionAccountPool(
    settings.accounts,
    settings.maximumConcurrentTasksPerAccount,
    settings.maximumQueuedTasks,
  );
  const persistentRunner = new PersistentCodexProcessRunner({
    accounts: settings.accounts,
    launcherPath: settings.launcherPath,
    packageManifestPath: settings.packageManifestPath,
    stateRoot: settings.stateRoot,
    workspacePath: settings.isolatedCwd,
    maximumConcurrentTasksPerAccount:
      settings.maximumConcurrentTasksPerAccount,
    maximumQueuedTasks: settings.maximumQueuedTasks,
  });
  const localEncryptionKey = (
    await readFile(settings.localEncryptionKeyFile, "utf8")
  ).trim();
  const conversationEnvironment = buildChildEnvironment(
    process.env,
    localEncryptionKey,
    conversationAnswerExecutionProfile.reasoningEffort,
  );
  const executor = new SubscriptionRuntimeExecutor({
    accountPool,
    childSourceEnvironment: process.env,
    installationInspector: new FileInstallationInspector({
      expectedLauncherSha256: settings.expectedLauncherSha256,
      launcherPath: settings.launcherPath,
      packageManifestPath: settings.packageManifestPath,
    }),
    isolatedCwd: settings.isolatedCwd,
    killGraceMs: settings.killGraceMs,
    localEncryptionKeyFile: settings.localEncryptionKeyFile,
    maxPromptBytes: settings.maxPromptBytes,
    maxStderrBytes: settings.maxStderrBytes,
    maxStdoutBytes: settings.maxStdoutBytes,
    maxTaskTimeoutMs: settings.maxTaskTimeoutMs,
    conversationProcessRunner: persistentRunner,
    conversationStreamingProcessRunner: persistentRunner,
    processRunner: new NodeProcessRunner(),
    readinessInspector: new FileRuntimeReadinessInspector({
      authJsonPaths: settings.accounts.map((account) => account.authJsonPath),
      isolatedCwd: settings.isolatedCwd,
      localEncryptionKeyFile: settings.localEncryptionKeyFile,
      stateRoot: settings.stateRoot,
    }),
    stateRoot: settings.stateRoot,
  });
  const server = await startPreparedSidecar({
    disposePreparedRuntime: async () => persistentRunner.dispose(),
    prepareRuntime: async () => {
      const result = await persistentRunner.prewarmAccounts(
        {
          execution: conversationAnswerExecutionProfile,
          outputSchema: providerConversationAnswerJsonSchema,
        },
        conversationEnvironment,
      );
      for (const failure of result.failures) {
        process.stderr.write(
          `Subscription runtime ${failure.slotId} prewarm failed: ${failure.code}\n`,
        );
      }
    },
    startServer: async () => startGrpcServer({
      bindAddress: settings.bindAddress,
      executor,
      streamingExecutor: executor,
      options: {
        isolatedCwd: settings.isolatedCwd,
        maxPromptBytes: settings.maxPromptBytes,
        maxTaskTimeoutMs: settings.maxTaskTimeoutMs,
        serviceToken: settings.serviceToken,
      },
      protoPath: settings.protoPath,
    }),
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.tryShutdown(() => {
      void persistentRunner.dispose();
    });
    setTimeout(() => {
      server.forceShutdown();
      void persistentRunner.dispose();
    }, 5_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void bootstrap().catch((error: unknown) => {
  const reason = error instanceof Error
    ? error.message.replaceAll(/[\r\n]+/gu, " ").slice(0, 1_000)
    : "unknown startup failure";
  process.stderr.write(`Subscription runtime sidecar failed to start: ${reason}\n`);
  process.exitCode = 1;
});
