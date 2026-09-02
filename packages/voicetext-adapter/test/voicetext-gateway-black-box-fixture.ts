import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocketServer } from "ws";

export const LOOPBACK_TOKEN = "loopback-contract-token-32-bytes-0001";

type Provider = "deepgram" | "elevenlabs";

type BatchJob = {
  readonly completed: Record<string, unknown>;
  readonly pending: Record<string, unknown>;
};

export type LoopbackGateway = {
  readonly counters: Record<`${Provider}_${"batch" | "live"}`, number>;
  readonly fixturePath: string;
  readonly httpOrigin: URL;
  readonly wsOrigin: URL;
  stop(): Promise<void>;
};

const providerProfiles = [
  { mode: "live", model: "nova-3", profile: "deepgram-nova-3", protocol_version: 2, provider: "deepgram", ready: true },
  { mode: "live", model: "scribe_v2_realtime", profile: "elevenlabs-scribe-v2-realtime", protocol_version: 2, provider: "elevenlabs", ready: true },
  { contract_version: 2, mode: "batch", model: "nova-3", profile: "deepgram-nova-3", provider: "deepgram", ready: true },
  { contract_version: 3, mode: "batch", model: "scribe_v2", profile: "elevenlabs-scribe-v2", provider: "elevenlabs", ready: true },
] as const;

export async function startLoopbackGateway(): Promise<LoopbackGateway> {
  const counters = {
    deepgram_batch: 0,
    deepgram_live: 0,
    elevenlabs_batch: 0,
    elevenlabs_live: 0,
  };
  const jobs = new Map<string, BatchJob>();
  const directory = await mkdtemp(join(tmpdir(), "voicetext-cross-head-"));
  const fixturePath = join(directory, "synthetic.ogg");
  await writeFile(fixturePath, Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), Buffer.from("OpusHead")]));

  const server = createServer(async (request, response) => {
    try {
      await routeHttp(request, response, jobs, counters);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  const websocketServer = new WebSocketServer({ maxPayload: 64 * 1_024, noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/v1/transcribe/stream") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (request.headers.authorization !== `Bearer ${LOOPBACK_TOKEN}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });
  websocketServer.on("connection", (socket) => {
    socket.on("error", () => {
      // Resource-bound rejections are asserted by the client; the fixture must
      // not turn ws's expected 1009 path into an uncaught process error.
    });
    let sequence = 0;
    let transcriptSent = false;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        sequence += 1;
        socket.send(JSON.stringify({ type: "ack", seq: sequence }));
        if (!transcriptSent) {
          transcriptSent = true;
          for (const type of ["partial", "final"] as const) {
            socket.send(JSON.stringify({
              type,
              text: "synthetic live speech",
              start_ms: 20,
              duration_ms: 40,
              confidence: 0.9,
            }));
          }
        }
        return;
      }
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "config") {
        const provider = message.provider as Provider;
        counters[`${provider}_live`] += 1;
        socket.send(JSON.stringify({
          type: "ready",
          provider,
          model: message.model,
          session_id: `123e4567-e89b-42d3-a456-${String(counters[`${provider}_live`]).padStart(12, "0")}`,
        }));
      } else if (message.type === "finalize") {
        socket.send(JSON.stringify({ type: "finalize_complete", status: "flushed", saw_result: true }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback contract gateway did not bind TCP");
  }
  return {
    counters,
    fixturePath,
    httpOrigin: new URL(`http://127.0.0.1:${address.port}`),
    wsOrigin: new URL(`ws://127.0.0.1:${address.port}`),
    async stop() {
      for (const client of websocketServer.clients) {
        client.terminate();
      }
      websocketServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      await rm(directory, { force: true, recursive: true });
    },
  };
}

async function routeHttp(
  request: IncomingMessage,
  response: ServerResponse,
  jobs: Map<string, BatchJob>,
  counters: LoopbackGateway["counters"],
): Promise<void> {
  if (request.url === "/health") {
    json(response, 200, { status: "ok", provider_profiles: providerProfiles });
    return;
  }
  if (request.url === "/health/live" || request.url === "/health/ready") {
    json(response, 200, { status: "ok" });
    return;
  }
  if (request.url?.startsWith("/api/v1/transcribe/batch") === true &&
      request.headers.authorization !== `Bearer ${LOOPBACK_TOKEN}`) {
    json(response, 401, { error_code: "UNAUTHORIZED" }, { "x-voicetext-error-code": "UNAUTHORIZED" });
    return;
  }
  if (request.method === "POST" && request.url === "/api/v1/transcribe/batch") {
    if (Number(request.headers["content-length"] ?? 0) > 1_024 * 1_024) {
      request.resume();
      json(
        response,
        400,
        { error_code: "MULTIPART_FIELD_TOO_LARGE" },
        { "x-voicetext-error-code": "MULTIPART_FIELD_TOO_LARGE" },
      );
      return;
    }
    const key = request.headers["x-idempotency-key"];
    if (typeof key !== "string") {
      throw new Error("missing idempotency key");
    }
    const existing = jobs.get(key);
    if (existing !== undefined) {
      json(response, 200, existing.completed);
      return;
    }
    const body = (await readBody(request)).toString("latin1");
    const provider: Provider = body.includes("elevenlabs") ? "elevenlabs" : "deepgram";
    const jobId = `123e4567-e89b-42d3-a456-${String(jobs.size + 1).padStart(12, "0")}`;
    const job = batchJob(provider, jobId);
    jobs.set(key, job);
    counters[`${provider}_batch`] += 1;
    json(response, 202, job.pending);
    return;
  }
  const match = request.url?.match(/^\/api\/v1\/transcribe\/batch\/([^/]+)$/u);
  if (request.method === "GET" && match !== null && match !== undefined) {
    const job = [...jobs.values()].find(({ completed }) => completed.job_id === match[1]);
    if (job === undefined) {
      json(response, 404, { error_code: "NOT_FOUND" });
    } else {
      json(response, 200, job.completed);
    }
    return;
  }
  response.writeHead(404);
  response.end();
}

function batchJob(provider: Provider, jobId: string): BatchJob {
  if (provider === "deepgram") {
    return {
      pending: { success: true, status: "running", job_id: jobId, next_action: "poll", retry_after_ms: 1000 },
      completed: {
        success: true,
        status: "completed",
        job_id: jobId,
        result: {
          provider: "deepgram",
          model: "nova-3",
          language: "multi",
          text: "synthetic speech",
          duration_seconds: 0.014,
          utterances: [{ start: 0, end: 0.014, transcript: "synthetic speech", confidence: 0.95 }],
          readable_segments: [{ start: 0, end: 0.014, transcript: "synthetic speech", source_utterance_indices: [0] }],
        },
      },
    };
  }
  const identity = { contract_version: 3, provider: "elevenlabs", model: "scribe_v2", language: "multi" };
  return {
    pending: { ...identity, success: true, status: "running", job_id: jobId, next_action: "poll", retry_after_ms: 1000 },
    completed: {
      ...identity,
      success: true,
      status: "completed",
      job_id: jobId,
      result: {
        result_id: jobId,
        provider: "elevenlabs",
        model: "scribe_v2",
        language: "multi",
        text: "synthetic speech",
        duration_ms: 14,
        segments: [{ index: 0, start_ms: 0, end_ms: 14, text: "synthetic speech", confidence: 0.95 }],
        provider_request: { id: "loopback-request-1" },
      },
    },
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}
