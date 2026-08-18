import { describe, expect, it } from "vitest";

import { VoicetextAdapterError } from "../src/errors.js";
import {
  FetchVoicetextBatchClient,
  type VoicetextBatchFetch,
} from "../src/voicetext-batch-client.js";
import {
  voicetextBatchContractIdentity,
} from "../src/voicetext-batch-contract.js";

const idempotencyKey = "a".repeat(64);
const jobId = "00000000-0000-4000-8000-000000000001";
const identity = {
  contract_version: 3,
  job_id: jobId,
  language: "multi",
  model: "scribe_v2",
  provider: "elevenlabs",
} as const;

function client(fetchImplementation: VoicetextBatchFetch): FetchVoicetextBatchClient {
  return new FetchVoicetextBatchClient({
    endpoint: "https://api.voicetext.test/api/v1/transcribe/batch",
    profile: "elevenlabs-scribe-v2",
    token: "x",
  }, fetchImplementation);
}

function validOgg(): Uint8Array {
  const bytes = new Uint8Array(28);
  bytes.set(Buffer.from("OggS", "ascii"));
  bytes[26] = 1;
  return bytes;
}

function completedPayload(): Readonly<Record<string, unknown>> {
  return {
    ...identity,
    result: {
      duration_ms: 1_250,
      language: "multi",
      model: "scribe_v2",
      provider: "elevenlabs",
      provider_request: { id: "scribe-request-1" },
      result_id: jobId,
      segments: [{ confidence: 0.97, end_ms: 1_250, index: 0, start_ms: 250, text: "готовим релиз" }],
      text: "готовим релиз",
    },
    status: "completed",
    success: true,
  };
}

function completedWithResult(
  resultPatch: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const payload = completedPayload();
  return {
    ...payload,
    result: { ...(payload.result as Readonly<Record<string, unknown>>), ...resultPatch },
  };
}

function pendingPayload(): Readonly<Record<string, unknown>> {
  return {
    ...identity,
    next_action: "poll",
    retry_after_ms: 5_000,
    status: "running",
    success: true,
  };
}

function failedPayload(): Readonly<Record<string, unknown>> {
  return {
    ...identity,
    error_code: "TRANSCRIPTION_FAILED",
    retryable: false,
    status: "failed",
    success: false,
  };
}

async function submitWith(payload: unknown, status = 200) {
  return await client(async () => Response.json(payload, { status })).submit({
    audio: validOgg(),
    idempotencyKey,
    keyterms: ["Discord", "Craig", "Discord"],
    signal: new AbortController().signal,
  });
}

describe("FetchVoicetextBatchClient contract v3", () => {
  it("fails closed for an unsupported runtime batch profile", () => {
    expect(() => voicetextBatchContractIdentity(
      "elevenlabs-scribe-v2-typo",
    )).toThrow("Voicetext batch profile is unsupported");
  });

  it("sends the exact ElevenLabs v3 identity and maps duration_ms and segments", async () => {
    let capturedInit: RequestInit | undefined;
    const result = await client(async (_input, init) => {
      capturedInit = init;
      return Response.json(completedPayload());
    }).submit({
      audio: validOgg(),
      idempotencyKey,
      keyterms: ["Discord", "Craig", "Discord"],
      signal: new AbortController().signal,
    });

    expect(capturedInit?.headers).toMatchObject({
      "Content-Type": `multipart/form-data; boundary=discord-meeting-${idempotencyKey}`,
    });
    const body = capturedInit?.body;
    expect(body).toBeInstanceOf(Blob);
    if (!(body instanceof Blob)) {
      throw new Error("expected deterministic multipart bytes");
    }
    const multipart = Buffer.from(await body.arrayBuffer()).toString("latin1");
    expect(multipart).toContain('name="contract_version"\r\n\r\n3\r\n');
    expect(multipart).toContain('name="provider"\r\n\r\nelevenlabs\r\n');
    expect(multipart).toContain('name="model"\r\n\r\nscribe_v2\r\n');
    expect(multipart).toContain('name="language"\r\n\r\nmulti\r\n');
    expect(multipart).toContain('name="keyterms"\r\n\r\n["Craig","Discord"]\r\n');
    expect(multipart).toContain('name="file"; filename="speaker-track.ogg"\r\nContent-Type: audio/ogg');
    expect(result).toEqual({
      jobId,
      kind: "completed",
      result: {
        durationSeconds: 1.25,
        readableSegments: [],
        utterances: [{
          confidence: 0.97,
          endSeconds: 1.25,
          startSeconds: 0.25,
          transcript: "готовим релиз",
        }],
      },
    });
  });

  it("accepts exact pending and failed v3 identities", async () => {
    await expect(submitWith(pendingPayload(), 202)).resolves.toEqual({
      jobId,
      kind: "pending",
      nextAction: "poll",
      retryAfterMs: 5_000,
    });
    await expect(submitWith(failedPayload())).resolves.toEqual({
      errorCode: "TRANSCRIPTION_FAILED",
      jobId,
      kind: "failed",
      retryable: false,
    });
  });

  const invalidIdentities = [
    ["contract_version", undefined],
    ["provider", "deepgram"],
    ["model", "nova-3"],
    ["language", "ru"],
    ["job_id", undefined],
  ] as const;

  it.each([
    ["pending", pendingPayload(), 202],
    ["failed", failedPayload(), 200],
    ["completed", completedPayload(), 200],
  ] as const)("fails closed for every absent or mismatched %s identity field", async (_kind, payload, status) => {
    for (const [field, invalid] of invalidIdentities) {
      await expect(submitWith({ ...payload, [field]: invalid }, status)).rejects.toEqual(
        expect.objectContaining<Partial<VoicetextAdapterError>>({
          code: "invalid_provider_response",
          retryable: false,
        }),
      );
    }
  });

  it.each([
    ["result_id", completedWithResult({ result_id: undefined })],
    ["mismatched result_id", completedWithResult({ result_id: "00000000-0000-4000-8000-000000000002" })],
    ["duration_ms", completedWithResult({ duration_ms: undefined })],
    ["fractional duration_ms", completedWithResult({ duration_ms: 1.5 })],
    ["segments", completedWithResult({ segments: undefined })],
    ["segment duration", completedWithResult({ segments: [{ end_ms: 0, index: 0, start_ms: 0, text: "x" }] })],
    ["segment bounds", completedWithResult({ segments: [{ end_ms: 2_000, index: 0, start_ms: 0, text: "x" }] })],
    ["segment index", completedWithResult({ segments: [{ end_ms: 1_000, index: 1, start_ms: 0, text: "x" }] })],
    ["result provider", completedWithResult({ provider: "deepgram" })],
    ["missing result text", completedWithResult({ text: undefined })],
  ])("fails closed for invalid completed v3 %s", async (_label, payload) => {
    await expect(submitWith(payload)).rejects.toMatchObject({
      code: "invalid_provider_response",
      retryable: false,
    });
  });
});
