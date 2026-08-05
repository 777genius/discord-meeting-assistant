import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";

import {
  parseCraigPlaybackEvent,
  type CraigPlaybackCommand,
  type CraigPlaybackEvent,
} from "@discord-meeting/craig-gateway-contracts";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  CraigPlaybackGateway,
  type CraigPlaybackTransport,
  type CraigPlaybackTransportIdentity,
} from "./craig-playback-gateway.js";

const readyTimeoutMs = 5_000;
const playbackPath = "/v1/craig/playback";

export interface CraigPlaybackWebSocketServerOptions {
  readonly bearerToken: string;
  readonly gateway: CraigPlaybackGateway;
  readonly onInternalError?: (error: unknown) => void;
}

export interface CraigPlaybackWebSocketServer {
  close(): Promise<void>;
}

export function attachCraigPlaybackWebSocketServer(
  server: Server,
  options: CraigPlaybackWebSocketServerOptions,
): CraigPlaybackWebSocketServer {
  if (options.bearerToken.length < 16) {
    throw new Error("Craig playback bearer token is too short");
  }
  const webSocketServer = new WebSocketServer({ noServer: true });
  const upgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://meeting-platform.internal");
    if (url.pathname !== playbackPath) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!isAuthorized(request.headers.authorization, options.bearerToken)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  };
  server.on("upgrade", upgrade);
  webSocketServer.on("connection", (webSocket) => {
    const connection = new PendingCraigPlaybackSocket(webSocket, options);
    connection.start();
  });
  return {
    close: async (): Promise<void> => {
      server.off("upgrade", upgrade);
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

class PendingCraigPlaybackSocket implements CraigPlaybackTransport {
  public identity: CraigPlaybackTransportIdentity = {
    channelId: "pending",
    gatewaySessionId: "pending",
    guildId: "pending",
    recordingId: "pending",
  };
  private closeListener: (reason: string) => void = () => {};
  private eventListener: (event: CraigPlaybackEvent) => void = () => {};
  private registered = false;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly socket: WebSocket,
    private readonly options: CraigPlaybackWebSocketServerOptions,
  ) {}

  public start(): void {
    this.readyTimer = setTimeout(() => {
      this.socket.close(1008, "session-ready timeout");
    }, readyTimeoutMs);
    this.readyTimer.unref();
    this.socket.on("message", (data, isBinary) => {
      this.receive(data, isBinary);
    });
    this.socket.on("close", (_code, reason) => {
      this.clearReadyTimer();
      this.closeListener(reason.toString("utf8") || "transport disconnected");
    });
    this.socket.on("error", (error) => this.options.onInternalError?.(error));
  }

  public get bufferedBytes(): number {
    return this.socket.bufferedAmount;
  }

  public close(code: number, reason: string): void {
    this.socket.close(code, reason);
  }

  public onClose(listener: (reason: string) => void): void {
    this.closeListener = listener;
  }

  public onEvent(listener: (event: CraigPlaybackEvent) => void): void {
    this.eventListener = listener;
  }

  public send(command: CraigPlaybackCommand): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Craig playback WebSocket is not open"));
    }
    return new Promise<void>((resolve, reject) => {
      this.socket.send(JSON.stringify(command), (error) => {
        const transportError: unknown = error;
        if (transportError === undefined || transportError === null) {
          resolve();
        } else {
          reject(transportError);
        }
      });
    });
  }

  private receive(data: RawData, isBinary: boolean): void {
    try {
      if (isBinary) {
        throw new Error("Craig playback events must be JSON text");
      }
      const event = parseCraigPlaybackEvent(JSON.parse(rawDataToUtf8(data)) as unknown);
      if (!this.registered) {
        if (event.type !== "session-ready") {
          throw new Error("First Craig playback event must be session-ready");
        }
        this.clearReadyTimer();
        this.identity = {
          channelId: event.channelId,
          gatewaySessionId: event.gatewaySessionId,
          guildId: event.guildId,
          recordingId: event.recordingId,
        };
        this.registered = true;
        this.options.gateway.register(this);
        return;
      }
      this.eventListener(event);
    } catch (error) {
      this.options.onInternalError?.(error);
      this.socket.close(1008, "invalid playback event");
    }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== undefined) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
  }
}

function rawDataToUtf8(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

function rejectUpgrade(
  socket: import("node:stream").Duplex,
  status: number,
  reason: string,
): void {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) {
    return false;
  }
  const received = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
}
