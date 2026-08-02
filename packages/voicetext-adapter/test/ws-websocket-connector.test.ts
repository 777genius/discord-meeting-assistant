import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData } from "ws";

import { WsVoicetextWebSocketConnector } from "../src/ws-websocket-connector.js";

describe("WsVoicetextWebSocketConnector", () => {
  const servers: WebSocketServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
  });

  it("accepts the ws runtime null send callback as success", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address() as AddressInfo;
    const received = new Promise<readonly [string, string]>((resolve) => {
      server.once("connection", (socket, request) => {
        const frames: string[] = [];
        socket.on("message", (data) => {
          frames.push(rawDataBytes(data).toString("utf8"));
          if (frames.length === 2) {
            resolve([request.headers.authorization ?? "", frames.join(":")]);
          }
        });
      });
    });

    const signal = AbortSignal.timeout(5_000);
    const connection = await new WsVoicetextWebSocketConnector().connect({
      authorization: "Bearer service-token",
      endpoint: new URL(`ws://127.0.0.1:${address.port}`),
      handshakeTimeoutMs: 5_000,
      maxInboundFrameBytes: 1_024,
      signal,
    });

    await expect(connection.sendText("config", signal)).resolves.toBeUndefined();
    await expect(connection.sendBinary(Uint8Array.from([1, 2, 3]), signal)).resolves.toBeUndefined();
    await expect(received).resolves.toEqual(["Bearer service-token", "config:\u0001\u0002\u0003"]);
    await connection.close(1_000, "done");
  });
});

async function closeServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error: Error | null | undefined) => {
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function rawDataBytes(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
