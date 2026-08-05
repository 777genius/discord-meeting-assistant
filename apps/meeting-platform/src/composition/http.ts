import {
  attachCraigPlaybackWebSocketServer,
  type CraigPlaybackGateway,
  type CraigPlaybackWebSocketServer,
} from "@discord-meeting/craig-playback-adapter";
import type { Logger } from "@discord-meeting/observability-adapter";

import type { PlatformConfig } from "../config.js";
import type { ActiveRecordingChannelReader } from "../application/recording-ingress.js";
import {
  createCraigInboundRoutesPlugin,
  type CraigIngressPort,
} from "../adapters/inbound/craig/craig-inbound-routes.js";
import { createDiscordInstallRoutesPlugin } from "../discord-install-http/discord-install-routes.js";
import {
  createFastifyPlatformHttpHost,
  type FastifyPlatformHttpHost,
} from "../http/fastify-platform-http-host.js";
import {
  createOperationsRoutesPlugin,
  type PlatformHealthPort,
} from "../operations-http/operations-routes.js";
import type { PlatformStartupCleanup } from "./startup-cleanup.js";
import { classifyPlatformError } from "./observability.js";

export interface PlatformHttpComposition {
  readonly craigPlaybackWebSocket: CraigPlaybackWebSocketServer;
  readonly server: FastifyPlatformHttpHost;
}

export function createPlatformHttpComposition(input: {
  readonly cleanup: PlatformStartupCleanup;
  readonly config: PlatformConfig;
  readonly configuration: ActiveRecordingChannelReader;
  readonly craigPlaybackGateway: CraigPlaybackGateway;
  readonly health: PlatformHealthPort;
  readonly ingress: CraigIngressPort;
  readonly installUrls: { readonly craig: string; readonly meetingPlatform: string };
  readonly logger: Logger;
}): PlatformHttpComposition {
  const server = createFastifyPlatformHttpHost({
    bindAddress: input.config.bindAddress,
    onInternalError: (error) => {
      input.logger.error(
        "Platform HTTP request failed",
        classifyPlatformError(error),
      );
    },
    port: input.config.port,
    routePlugins: [
      createOperationsRoutesPlugin({
        bearerToken: input.config.secrets.craigBearerToken,
        health: input.health,
      }),
      createDiscordInstallRoutesPlugin({ installUrls: input.installUrls }),
      createCraigInboundRoutesPlugin({
        bearerToken: input.config.secrets.craigBearerToken,
        configuration: input.configuration,
        ingress: input.ingress,
      }),
    ],
  });
  input.cleanup.defer("platform HTTP host", () => server.close());
  const craigPlaybackWebSocket = attachCraigPlaybackWebSocketServer(server.rawServer, {
    bearerToken: input.config.secrets.craigBearerToken,
    gateway: input.craigPlaybackGateway,
    onInternalError: (error) => {
      input.logger.error("Craig playback transport failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    },
  });
  input.cleanup.defer("Craig playback WebSocket", () => craigPlaybackWebSocket.close());
  return { craigPlaybackWebSocket, server };
}
