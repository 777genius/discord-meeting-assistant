import { describe, expect, it } from "vitest";

import { VoicetextAdapterError } from "../src/errors.js";
import {
  FetchVoicetextBatchClient,
  batchEndpointFromWebSocketUrl,
  type VoicetextBatchFetch,
} from "../src/voicetext-batch-client.js";

const idempotencyKey = "a".repeat(64);
const jobId = "00000000-0000-4000-8000-000000000001";

describe("FetchVoicetextBatchClient", () => {
  it("sends the exact authenticated batch-v2 multipart contract and parses final segments", async () => {
    let capturedInput: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImplementation: VoicetextBatchFetch = async (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return Response.json(completedPayload());
    };
    const client = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, fetchImplementation);
    const signal = new AbortController().signal;

    const result = await client.submit({
      audio: validOgg(),
      idempotencyKey,
      keyterms: ["Deepgram", "Craig", "Deepgram"],
      signal,
    });

    expect(capturedInput).toBeInstanceOf(URL);
    if (!(capturedInput instanceof URL)) {
      throw new Error("expected batch request URL");
    }
    expect(capturedInput.href).toBe("https://api.voicetext.test/api/v1/transcribe/batch");
    expect(capturedInit).toMatchObject({
      headers: {
        Authorization: "Bearer machine-service-token-for-test",
        "X-Idempotency-Key": idempotencyKey,
      },
      method: "POST",
      redirect: "error",
      signal,
    });
    const form = capturedInit?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) {
      throw new Error("expected multipart form data");
    }
    expect([...form.keys()]).toEqual([
      "contract_version",
      "provider",
      "model",
      "language",
      "keyterms",
      "file",
    ]);
    expect(form.get("contract_version")).toBe("2");
    expect(form.get("provider")).toBe("deepgram");
    expect(form.get("model")).toBe("nova-3");
    expect(form.get("language")).toBe("multi");
    expect(form.get("keyterms")).toBe('["Craig","Deepgram"]');
    expect(form.get("file")).toMatchObject({
      name: "speaker-track.ogg",
      size: validOgg().byteLength,
      type: "audio/ogg",
    });
    expect(result).toEqual({
      jobId,
      kind: "completed",
      result: {
        durationSeconds: 1.25,
        utterances: [{
          confidence: 0.97,
          endSeconds: 1.25,
          startSeconds: 0.25,
          transcript: "готовим релиз",
        }],
      },
    });
  });

  it("parses a running result and polls the contract job URL with the machine bearer", async () => {
    const requests: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
    const fetchImplementation: VoicetextBatchFetch = async (input, init) => {
      requests.push({ input, init });
      return requests.length === 1
        ? Response.json({
            job_id: jobId,
            next_action: "poll",
            retry_after_ms: 5_000,
            status: "running",
            success: true,
          }, { status: 202 })
        : Response.json(completedPayload());
    };
    const client = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, fetchImplementation);
    const signal = new AbortController().signal;

    const pending = await client.submit({ audio: validOgg(), idempotencyKey, keyterms: [], signal });
    if (pending.kind !== "pending") {
      throw new Error("expected pending batch result");
    }
    const final = await client.poll({ jobId: pending.jobId, signal });

    expect(pending).toEqual({
      jobId,
      kind: "pending",
      nextAction: "poll",
      retryAfterMs: 5_000,
    });
    expect(final.kind).toBe("completed");
    expect(requests[1]?.input).toMatchObject({
      href: `https://api.voicetext.test/api/v1/transcribe/batch/${jobId}`,
    });
    expect(requests[1]?.init).toMatchObject({
      headers: { Authorization: "Bearer machine-service-token-for-test" },
      method: "GET",
      redirect: "error",
      signal,
    });
  });
});

describe("FetchVoicetextBatchClient failure policy", () => {
  it("fails closed when a poll response belongs to another batch job", async () => {
    const client = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, async () => Response.json({
      ...completedPayload(),
      job_id: "00000000-0000-4000-8000-000000000002",
    }));

    await expect(client.poll({
      jobId,
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining<Partial<VoicetextAdapterError>>({
      code: "invalid_provider_response",
      retryable: false,
    }));
  });

  it("cancels an oversized chunked response instead of retaining the connection", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start: (controller) => {
        controller.enqueue(new Uint8Array(2_097_153));
      },
    });
    const client = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, async () => new Response(body, { status: 200 }));

    await expect(client.submit({
      audio: validOgg(),
      idempotencyKey,
      keyterms: [],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "invalid_provider_response" });
    expect(cancelled).toBe(true);
  });

  it("fails closed when the server reports an idempotency fingerprint conflict", async () => {
    const client = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, async () => new Response(null, { status: 409 }));

    await expect(client.submit({
      audio: validOgg(),
      idempotencyKey,
      keyterms: [],
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining<Partial<VoicetextAdapterError>>({
      code: "idempotency_conflict",
      retryable: false,
    }));
  });

  it("classifies a transient non-200 response as retryable without exposing its body", async () => {
    const client = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, async () => new Response("provider detail must stay private", { status: 503 }));

    await expect(client.submit({
      audio: validOgg(),
      idempotencyKey,
      keyterms: [],
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining<Partial<VoicetextAdapterError>>({
      code: "request_failed",
      retryable: true,
    }));
  });

  it("accepts only bounded integer-second Retry-After hints from a retryable response", async () => {
    const client = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, async () => new Response(null, {
      headers: { "Retry-After": "15" },
      status: 429,
    }));

    await expect(client.submit({
      audio: validOgg(),
      idempotencyKey,
      keyterms: [],
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining<Partial<VoicetextAdapterError>>({
      code: "request_failed",
      retryAfterMs: 15_000,
      retryable: true,
    }));
  });

  it("treats quota exhaustion as terminal even though the transport status is 429", async () => {
    const client = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, async () => new Response(null, {
      headers: {
        "Retry-After": "15",
        "X-Voicetext-Error-Code": "LIMIT_EXCEEDED",
      },
      status: 429,
    }));

    await expect(client.submit({
      audio: validOgg(),
      idempotencyKey,
      keyterms: [],
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining<Partial<VoicetextAdapterError>>({
      code: "quota_exceeded",
      retryable: false,
    }));
  });

  it("keeps service rate limiting retryable and preserves its bounded retry hint", async () => {
    const client = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, async () => new Response(null, {
      headers: {
        "Retry-After": "7",
        "X-Voicetext-Error-Code": "RATE_LIMIT_EXCEEDED",
      },
      status: 429,
    }));

    await expect(client.submit({
      audio: validOgg(),
      idempotencyKey,
      keyterms: [],
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining<Partial<VoicetextAdapterError>>({
      code: "rate_limited",
      retryAfterMs: 7_000,
      retryable: true,
    }));
  });

  it("caps large Retry-After values and ignores HTTP-date values", async () => {
    const cappedClient = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, async () => new Response(null, {
      headers: { "Retry-After": "999999" },
      status: 429,
    }));
    await expect(cappedClient.submit({
      audio: validOgg(),
      idempotencyKey,
      keyterms: [],
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining<Partial<VoicetextAdapterError>>({
      retryAfterMs: 3_600_000,
    }));

    const dateClient = new FetchVoicetextBatchClient({
      endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
      token: "machine-service-token-for-test",
    }, async () => new Response(null, {
      headers: { "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" },
      status: 429,
    }));
    await expect(dateClient.submit({
      audio: validOgg(),
      idempotencyKey,
      keyterms: [],
      signal: new AbortController().signal,
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof VoicetextAdapterError && error.retryAfterMs === undefined,
    );
  });

  it("derives a same-origin HTTPS batch endpoint from the configured secure live endpoint", () => {
    expect(batchEndpointFromWebSocketUrl(
      "wss://api.voicetext.test/api/v1/transcribe/stream",
    )).toBe("https://api.voicetext.test/api/v1/transcribe/batch");
  });
});

function completedPayload(): Readonly<Record<string, unknown>> {
  return {
    job_id: jobId,
    result: {
      duration_seconds: 1.25,
      language: "multi",
      model: "nova-3",
      provider: "deepgram",
      text: "готовим релиз",
      utterances: [{
        confidence: 0.97,
        end: 1.25,
        start: 0.25,
        transcript: "готовим релиз",
      }],
    },
    status: "completed",
    success: true,
  };
}

function validOgg(): Uint8Array {
  const bytes = new Uint8Array(27);
  bytes.set([79, 103, 103, 83]);
  return bytes;
}
