import { once } from "node:events";
import { createConnection } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createFastifyPlatformHttpHost } from "../src/http/fastify-platform-http-host.js";

const sockets = new Set<ReturnType<typeof createConnection>>();

afterEach(() => {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
});

describe("FastifyPlatformHttpHost shutdown", () => {
  it("force-closes a client that never finishes its request body", async () => {
    const host = createFastifyPlatformHttpHost({
      bindAddress: "127.0.0.1",
      port: 0,
      routePlugins: [],
      shutdownTimeoutMilliseconds: 25,
    });
    await host.start();
    const address = host.rawServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an ephemeral TCP listener");
    }
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    sockets.add(socket);
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(
      "POST /v1/craig/events HTTP/1.1\r\n" +
        "Host: localhost\r\n" +
        "Authorization: Bearer 0123456789abcdef\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 100\r\n\r\n" +
        '{"schemaVersion":',
    );

    await expect(host.close()).resolves.toBeUndefined();
    expect(host.rawServer.listening).toBe(false);
  }, 20_000);
});
