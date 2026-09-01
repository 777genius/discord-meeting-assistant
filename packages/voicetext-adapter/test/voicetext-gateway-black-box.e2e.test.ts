import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const suppliedOrigin = process.env.VOICETEXT_GATEWAY_BLACK_BOX_ORIGIN;
const originRequired = process.env.VOICETEXT_GATEWAY_BLACK_BOX_REQUIRE_ORIGIN === "1";

if (originRequired && suppliedOrigin === undefined) {
  throw new Error("VOICETEXT_GATEWAY_BLACK_BOX_ORIGIN is required by the exact-head gate");
}

describe("VoiceText gateway black-box cross-head fixture", () => {
  let inMemoryServer!: Server;
  let inMemoryOrigin = "";

  beforeAll(async () => {
    inMemoryServer = createContractServer();
    await new Promise<void>((resolve, reject) => {
      inMemoryServer.once("error", reject);
      inMemoryServer.listen(0, "127.0.0.1", resolve);
    });
    const address = inMemoryServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("in-memory gateway fixture did not bind TCP");
    }
    inMemoryOrigin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      inMemoryServer.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("executes the in-memory gateway routing contract", async () => {
    await assertGatewayRoutingContract(inMemoryOrigin);
  });

  it.skipIf(suppliedOrigin === undefined)(
    "executes the same contract against a production-compatible gateway origin",
    async () => {
      await assertGatewayRoutingContract(requireOrigin(suppliedOrigin));
    },
  );
});

async function assertGatewayRoutingContract(origin: string): Promise<void> {
  const normalized = gatewayOrigin(origin);
  for (const path of ["/health", "/health/live", "/health/ready"]) {
    const response = await fetch(new URL(path, normalized), {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status, `${path} must be routed`).toBe(200);
  }
  const protectedResponse = await fetch(new URL("/api/v1/transcribe/batch", normalized), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  expect([401, 403]).toContain(protectedResponse.status);
  const unknown = await fetch(new URL("/__voicetext_cross_head_unknown__", normalized), {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  expect(unknown.status).toBe(404);
}

function gatewayOrigin(raw: string): URL {
  const origin = new URL(raw);
  if (!["http:", "https:"].includes(origin.protocol) || origin.pathname !== "/" ||
      origin.search !== "" || origin.hash !== "" || origin.username !== "" ||
      origin.password !== "") {
    throw new Error("gateway black-box origin must be a credential-free HTTP(S) origin");
  }
  return origin;
}

function requireOrigin(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("gateway origin was not supplied");
  }
  return value;
}

function createContractServer(): Server {
  return createServer((request, response) => {
    if (["/health", "/health/live", "/health/ready"].includes(request.url ?? "")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    if (request.url === "/api/v1/transcribe/batch") {
      response.writeHead(401);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
}
