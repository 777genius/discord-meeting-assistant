import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OfficialOpenAiClient } from "../src/openai-client.js";

describe("OfficialOpenAiClient", () => {
  it("maps audio bytes to the timestamp-preserving transcription request", async () => {
    const create = vi.fn(async (_request: unknown, _options: unknown) => ({
      duration: 1,
      language: "en",
      text: "hello",
      segments: [{ id: 0, start: 0, end: 1, text: "hello" }],
    }));
    const sdk = {
      audio: { transcriptions: { create } },
      responses: { parse: vi.fn() },
    } as unknown as OpenAI;
    const client = new OfficialOpenAiClient(sdk);

    await client.createTranscription({
      audio: new Uint8Array([1, 2, 3]),
      fileName: "speaker.flac",
      idempotencyKey: "transcription-request-1",
      mediaType: "audio/flac",
      model: "whisper-1",
      language: "en",
      prompt: "Vocabulary: Craig",
    });

    expect(create).toHaveBeenCalledOnce();
    const sentRequest = create.mock.calls[0]?.[0] as {
      readonly file: File;
    } & Readonly<Record<string, unknown>>;
    expect(sentRequest).toMatchObject({
      model: "whisper-1",
      language: "en",
      prompt: "Vocabulary: Craig",
      response_format: "verbose_json",
      temperature: 0,
      timestamp_granularities: ["segment"],
    });
    const { file } = sentRequest;
    expect(file).toBeInstanceOf(File);
    expect(file).toMatchObject({ name: "speaker.flac", type: "audio/flac", size: 3 });
    expect(create.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: "transcription-request-1",
    });
  });

  it("uses Responses structured output without storing provider data", async () => {
    const output = { value: "structured" };
    const parse = vi.fn(async (_request: unknown, _options: unknown) => ({
      id: "response-1",
      status: "completed",
      output_parsed: output,
      output: [],
      incomplete_details: null,
    }));
    const sdk = {
      audio: { transcriptions: { create: vi.fn() } },
      responses: { parse },
    } as unknown as OpenAI;
    const client = new OfficialOpenAiClient(sdk);

    const result = await client.createStructuredResponse({
      idempotencyKey: "summary-request-1",
      model: "gpt-5.6",
      maxOutputTokens: 1_024,
      schemaName: "test_schema",
      schema: z.object({ value: z.string() }),
      messages: [
        { role: "developer", content: "Follow the schema." },
        { role: "user", content: "Input" },
      ],
    });

    expect(result).toEqual({
      status: "completed",
      parsed: output,
      responseId: "response-1",
    });
    expect(parse).toHaveBeenCalledOnce();
    expect(parse.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-5.6",
      max_output_tokens: 1_024,
      store: false,
      text: { format: { type: "json_schema", name: "test_schema", strict: true } },
    });
    expect(parse.mock.calls[0]?.[1]).toEqual({ idempotencyKey: "summary-request-1" });
  });

  it("normalizes a structured-output refusal", async () => {
    const sdk = {
      audio: { transcriptions: { create: vi.fn() } },
      responses: {
        parse: vi.fn(async () => ({
          id: "response-2",
          status: "completed",
          output_parsed: null,
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "not allowed" }],
            },
          ],
          incomplete_details: null,
        })),
      },
    } as unknown as OpenAI;
    const client = new OfficialOpenAiClient(sdk);

    const result = await client.createStructuredResponse({
      idempotencyKey: "summary-request-2",
      model: "gpt-5.6",
      maxOutputTokens: 1_024,
      schemaName: "test_schema",
      schema: z.object({ value: z.string() }),
      messages: [{ role: "user", content: "Input" }],
    });

    expect(result).toEqual({
      status: "refused",
      reason: "not allowed",
      responseId: "response-2",
    });
  });
});
