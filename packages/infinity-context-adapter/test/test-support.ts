import type {
  HttpRequest,
  JsonValue,
} from "@infinity-context/sdk";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { DisposableInfinityEndpoint } from "./disposable-infinity-endpoint.js";

const maximumRequestBytes = 2 * 1_024 * 1_024;
type HttpMethod = HttpRequest["method"];
const supportedMethods = new Set<HttpMethod>([
  "DELETE",
  "GET",
  "PATCH",
  "POST",
  "PUT",
]);

export { DisposableInfinityEndpoint } from "./disposable-infinity-endpoint.js";

export interface DisposableInfinityHttpService {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly endpoint: DisposableInfinityEndpoint;
}

/**
 * Disposable HTTP boundary used only by integration tests. Production
 * composition therefore exercises the official SDK's real FetchTransport,
 * while the in-memory endpoint remains deterministic and contains no user
 * data.
 */
export async function startDisposableInfinityHttpService(
  endpoint = new DisposableInfinityEndpoint(),
): Promise<DisposableInfinityHttpService> {
  const server = createServer((request, response) => {
    void serve(endpoint, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("disposable Infinity HTTP service did not bind a TCP port");
  }
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    }),
    endpoint,
  });
}

async function serve(
  endpoint: DisposableInfinityEndpoint,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const method = incoming.method;
  if (method === undefined || !supportedMethods.has(method as HttpMethod)) {
    outgoing.writeHead(405).end();
    return;
  }
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("disposable HTTP request closed", "AbortError"));
    }
  };
  incoming.once("aborted", abort);
  outgoing.once("close", () => {
    if (!outgoing.writableEnded) {
      abort();
    }
  });
  try {
    const bytes = await readBoundedBody(incoming);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) {
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
    }
    const request: HttpRequest = {
      ...(bytes.length === 0
        ? {}
        : { body: { kind: "json" as const, value: parseJson(bytes) } }),
      headers,
      method: method as HttpMethod,
      signal: controller.signal,
      url: new URL(incoming.url ?? "/", "http://127.0.0.1"),
    };
    const response = await endpoint.send(request);
    if (outgoing.destroyed) {
      return;
    }
    for (const [name, value] of response.headers) {
      outgoing.setHeader(name, value);
    }
    outgoing.statusCode = response.status;
    outgoing.end(response.body);
  } catch {
    // A committed mutation whose response is lost is represented by closing
    // the socket, so FetchTransport observes the same ambiguous network result
    // it would see against a real service.
    outgoing.destroy();
  }
}

async function readBoundedBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const value of request) {
    const chunk = typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value as Buffer);
    total += chunk.byteLength;
    if (total > maximumRequestBytes) {
      throw new Error("disposable Infinity request exceeded its test bound");
    }
    chunks.push(chunk);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseJson(bytes: Uint8Array): JsonValue {
  return JSON.parse(new TextDecoder().decode(bytes)) as JsonValue;
}
