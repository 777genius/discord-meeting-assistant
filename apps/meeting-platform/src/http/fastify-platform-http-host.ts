import type { Server } from "node:http";
import type { Socket } from "node:net";

import fastify, {
  type FastifyPluginCallback,
  type InjectOptions,
  type LightMyRequestResponse,
} from "fastify";
import { sendJson } from "./http-response.js";
import type { PlatformHttpHost } from "./platform-http-host.js";

const requestTimeoutMilliseconds = 300_000;
const headersTimeoutMilliseconds = 10_000;
const keepAliveTimeoutMilliseconds = 5_000;
const maximumRequestsPerSocket = 1_000;
const defaultShutdownTimeoutMilliseconds = 15_000;

export interface FastifyPlatformHttpHostOptions {
  readonly bindAddress: string;
  readonly onInternalError?: (error: unknown) => void;
  readonly port: number;
  readonly routePlugins: readonly FastifyPluginCallback[];
  readonly shutdownTimeoutMilliseconds?: number;
}

export class FastifyPlatformHttpHost implements PlatformHttpHost {
  readonly #app;
  readonly #connections = new Set<Socket>();

  public constructor(private readonly options: FastifyPlatformHttpHostOptions) {
    if (
      options.shutdownTimeoutMilliseconds !== undefined &&
      (!Number.isSafeInteger(options.shutdownTimeoutMilliseconds) ||
        options.shutdownTimeoutMilliseconds <= 0 ||
        options.shutdownTimeoutMilliseconds > 60_000)
    ) {
      throw new Error("HTTP shutdown timeout must be an integer from 1 to 60000");
    }
    this.#app = fastify({
      keepAliveTimeout: keepAliveTimeoutMilliseconds,
      logger: false,
      maxRequestsPerSocket: maximumRequestsPerSocket,
      requestTimeout: requestTimeoutMilliseconds,
    });
    this.#app.server.headersTimeout = headersTimeoutMilliseconds;
    this.#app.server.on("connection", (socket) => {
      this.#connections.add(socket);
      socket.once("close", () => this.#connections.delete(socket));
    });
    this.#app.setNotFoundHandler((_request, reply) => {
      sendJson(reply, 404, { code: "NOT_FOUND" });
    });
    this.#app.setErrorHandler((error, _request, reply) => {
      if (hasFastifyErrorCode(error, "FST_ERR_CTP_BODY_TOO_LARGE")) {
        sendJson(reply, 413, { code: "BODY_TOO_LARGE" });
        return;
      }
      if (hasFastifyErrorCode(error, "FST_ERR_CTP_INVALID_JSON_BODY")) {
        sendJson(reply, 400, { code: "INVALID_REQUEST" });
        return;
      }
      this.options.onInternalError?.(error);
      sendJson(reply, 500, { code: "INTERNAL_ERROR" });
    });
    for (const routePlugin of options.routePlugins) {
      this.#app.register(routePlugin);
    }
  }

  public get rawServer(): Server {
    return this.#app.server;
  }

  public async close(): Promise<void> {
    const closing = this.#app.close();
    const timeout = setTimeout(() => {
      for (const socket of this.#connections) {
        socket.destroy();
      }
      this.#app.server.closeAllConnections();
    }, this.options.shutdownTimeoutMilliseconds ?? defaultShutdownTimeoutMilliseconds);
    timeout.unref();
    try {
      await closing;
    } finally {
      clearTimeout(timeout);
    }
  }

  public inject(options: InjectOptions | string): Promise<LightMyRequestResponse> {
    return this.#app.inject(options);
  }

  public async start(): Promise<void> {
    await this.#app.listen({ host: this.options.bindAddress, port: this.options.port });
  }
}

export function createFastifyPlatformHttpHost(
  options: FastifyPlatformHttpHostOptions,
): FastifyPlatformHttpHost {
  return new FastifyPlatformHttpHost(options);
}

function hasFastifyErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
