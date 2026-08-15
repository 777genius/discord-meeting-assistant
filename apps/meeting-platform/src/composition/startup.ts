import { once } from "node:events";

import {
  registerDiscordGuildSetupCommand,
  type DiscordGuildSetupCommandHandler,
} from "@discord-meeting/discord-adapter";
import type { Client } from "discord.js";
import type { Pool } from "pg";

import type { PlatformConfig } from "../config.js";
import type { PlatformHttpHost } from "../http/platform-http-host.js";

export interface PlatformSchemaReadinessPort {
  assertReady(): Promise<void>;
}

export interface PlatformDependencyReadinessPort {
  assertReady(): Promise<void>;
}

interface ExclusiveRecordingSpoolOwner {
  acquireExclusiveSpoolOwnership(): Promise<void>;
}

interface PostCallOutboxDispatchPort {
  dispatchPending(): Promise<unknown>;
}

interface PostCallWorkerLifecycle {
  run(): Promise<void>;
  waitUntilReady(): Promise<unknown>;
}

interface StartupLogger {
  error(message: string, context: Record<string, unknown>): void;
  info(message: string, context: Record<string, unknown>): void;
}

export async function startPlatformServices(input: {
  readonly config: PlatformConfig;
  readonly dependencyReadiness: PlatformDependencyReadinessPort;
  readonly discord: Client;
  readonly guildSetupHandler: DiscordGuildSetupCommandHandler;
  readonly historicalMemory?: {
    assertReady(): Promise<void>;
    start(): Promise<void>;
  };
  readonly logger: StartupLogger;
  readonly meetingPlatformInstallUrl: string;
  readonly outboxDispatcher: PostCallOutboxDispatchPort;
  readonly pool: Pool;
  readonly recordings: ExclusiveRecordingSpoolOwner;
  readonly queue: { waitUntilReady(): Promise<unknown> };
  readonly queueEvents: { waitUntilReady(): Promise<unknown> };
  readonly schemaReadiness: PlatformSchemaReadinessPort;
  readonly server: PlatformHttpHost;
  readonly worker: PostCallWorkerLifecycle;
}): Promise<void> {
  await input.recordings.acquireExclusiveSpoolOwnership();
  await waitForCoreDependencies(input);
  await input.historicalMemory?.assertReady();
  await loginDiscord(input.config, input.discord);
  await registerDiscordGuildSetupCommand(input.discord);
  await input.dependencyReadiness.assertReady();
  input.guildSetupHandler.start();
  await input.worker.waitUntilReady();
  await startPostCallWorker(input.worker, input.logger);
  await input.outboxDispatcher.dispatchPending();
  await input.historicalMemory?.start();
  await input.server.start();
  input.logger.info("Meeting platform is ready", {
    discordInstallUrl: input.meetingPlatformInstallUrl,
    port: input.config.port,
  });
}

async function waitForCoreDependencies(input: {
  readonly pool: Pool;
  readonly queue: { waitUntilReady(): Promise<unknown> };
  readonly queueEvents: { waitUntilReady(): Promise<unknown> };
  readonly schemaReadiness: PlatformSchemaReadinessPort;
}): Promise<void> {
  await input.pool.query("SELECT 1");
  await Promise.all([
    input.schemaReadiness.assertReady(),
    input.queue.waitUntilReady(),
    input.queueEvents.waitUntilReady(),
  ]);
}

async function startPostCallWorker(
  worker: PostCallWorkerLifecycle,
  logger: StartupLogger,
): Promise<void> {
  let startupFailure: unknown;
  const running = worker.run();
  void running.catch((error: unknown) => {
    startupFailure = error;
    logger.error("Post-call worker runtime failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
  });
  // `Worker.run()` is intentionally long-lived. One microtask catches an
  // immediate startup rejection without delaying admission for its whole life.
  await Promise.resolve();
  if (startupFailure !== undefined) {
    throw new Error("Post-call worker failed during startup", {
      cause: startupFailure,
    });
  }
}

async function loginDiscord(config: PlatformConfig, discord: Client): Promise<void> {
  const ready = once(discord, "clientReady");
  await discord.login(config.secrets.discordToken);
  if (!discord.isReady()) {
    await ready;
  }
  const application = discord.application;
  if (application === null || application.id !== config.discordApplicationId) {
    throw new Error("Discord application ID does not match the configured bot token");
  }
}
