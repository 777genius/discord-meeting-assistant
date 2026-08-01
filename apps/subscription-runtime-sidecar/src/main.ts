import { FileInstallationInspector } from "./installation-inspector.js";
import { NodeProcessRunner } from "./node-process-runner.js";
import { FileRuntimeReadinessInspector } from "./runtime-readiness.js";
import { resolveSidecarSettings } from "./settings.js";
import { startGrpcServer } from "./grpc-server.js";
import { SubscriptionRuntimeExecutor } from "./subscription-runtime-executor.js";

async function bootstrap(): Promise<void> {
  const settings = await resolveSidecarSettings(process.env);
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
    processRunner: new NodeProcessRunner(),
    readinessInspector: new FileRuntimeReadinessInspector({
      authJsonPath: settings.authJsonPath,
      isolatedCwd: settings.isolatedCwd,
      localEncryptionKeyFile: settings.localEncryptionKeyFile,
      stateRoot: settings.stateRoot,
    }),
    stateRoot: settings.stateRoot,
  });
  const server = await startGrpcServer({
    bindAddress: settings.bindAddress,
    executor,
    options: {
      isolatedCwd: settings.isolatedCwd,
      maxPromptBytes: settings.maxPromptBytes,
      maxTaskTimeoutMs: settings.maxTaskTimeoutMs,
      serviceToken: settings.serviceToken,
    },
    protoPath: settings.protoPath,
  });

  const shutdown = (): void => {
    server.tryShutdown(() => {});
    setTimeout(() => {
      server.forceShutdown();
    }, 5_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void bootstrap().catch(() => {
  process.stderr.write("Subscription runtime sidecar failed to start\n");
  process.exitCode = 1;
});
