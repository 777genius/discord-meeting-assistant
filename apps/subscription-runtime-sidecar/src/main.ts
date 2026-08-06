import { readFile } from "node:fs/promises";

import {
  conversationAnswerExecutionProfile,
  finalSummaryExecutionProfile,
  providerConversationAnswerJsonSchema,
  providerMeetingSummaryJsonSchema,
} from "@discord-meeting/subscription-runtime-adapter";

import { providerInstanceId } from "./constants.js";
import { startGrpcServer } from "./grpc-server.js";
import { FileInstallationInspector } from "./installation-inspector.js";
import { PersistentCodexProcessRunner } from "./persistent-codex-process-runner.js";
import { FileRuntimeReadinessInspector } from "./runtime-readiness.js";
import { resolveSidecarSettings } from "./settings.js";
import { startPreparedSidecar } from "./sidecar-startup.js";
import {
  buildChildEnvironment,
  SubscriptionRuntimeExecutor,
} from "./subscription-runtime-executor.js";

async function bootstrap(): Promise<void> {
  const settings = await resolveSidecarSettings(process.env);
  const persistentRunner = new PersistentCodexProcessRunner({
    authJsonPath: settings.authJsonPath,
    launcherPath: settings.launcherPath,
    packageManifestPath: settings.packageManifestPath,
    providerInstanceId,
    stateRoot: settings.stateRoot,
    workspacePath: settings.isolatedCwd,
  });
  const localEncryptionKey = (
    await readFile(settings.localEncryptionKeyFile, "utf8")
  ).trim();
  const conversationEnvironment = buildChildEnvironment(
    process.env,
    localEncryptionKey,
    conversationAnswerExecutionProfile.reasoningEffort,
  );
  const finalSummaryEnvironment = buildChildEnvironment(
    process.env,
    localEncryptionKey,
    finalSummaryExecutionProfile.reasoningEffort,
  );
  const executor = new SubscriptionRuntimeExecutor({
    authJsonPath: settings.authJsonPath,
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
    processRunner: persistentRunner,
    readinessInspector: new FileRuntimeReadinessInspector({
      authJsonPath: settings.authJsonPath,
      isolatedCwd: settings.isolatedCwd,
      localEncryptionKeyFile: settings.localEncryptionKeyFile,
      stateRoot: settings.stateRoot,
    }),
    stateRoot: settings.stateRoot,
  });
  const server = await startPreparedSidecar({
    disposePreparedRuntime: async () => persistentRunner.dispose(),
    prepareRuntime: async () => {
      await Promise.all([
        persistentRunner.prewarm(
          {
            execution: conversationAnswerExecutionProfile,
            outputSchema: providerConversationAnswerJsonSchema,
          },
          conversationEnvironment,
        ),
        persistentRunner.prewarm(
          {
            execution: finalSummaryExecutionProfile,
            outputSchema: providerMeetingSummaryJsonSchema,
          },
          finalSummaryEnvironment,
        ),
      ]);
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
