import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";

export interface OpenAiTranscriptionRequest {
  readonly audio: Uint8Array;
  readonly fileName: string;
  readonly idempotencyKey: string;
  readonly mediaType: string;
  readonly model: "whisper-1";
  readonly language?: string;
  readonly prompt?: string;
  readonly signal?: AbortSignal;
}

export interface OpenAiStructuredMessage {
  readonly role: "developer" | "user";
  readonly content: string;
}

export interface OpenAiStructuredRequest<T> {
  readonly idempotencyKey: string;
  readonly model: string;
  readonly messages: readonly OpenAiStructuredMessage[];
  readonly maxOutputTokens: number;
  readonly schemaName: string;
  readonly schema: z.ZodType<T>;
}

export type OpenAiStructuredResponse =
  | {
      readonly status: "completed";
      readonly parsed: unknown;
      readonly responseId: string;
    }
  | {
      readonly status: "incomplete";
      readonly reason: string;
      readonly responseId: string;
    }
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly responseId: string;
    };

export interface OpenAiTranscriptionClient {
  createTranscription(request: OpenAiTranscriptionRequest): Promise<unknown>;
}

export interface OpenAiStructuredResponseClient {
  createStructuredResponse<T>(
    request: OpenAiStructuredRequest<T>,
  ): Promise<OpenAiStructuredResponse>;
}

export class OfficialOpenAiClient
  implements OpenAiTranscriptionClient, OpenAiStructuredResponseClient
{
  public constructor(private readonly client: OpenAI) {}

  public async createTranscription(request: OpenAiTranscriptionRequest): Promise<unknown> {
    request.signal?.throwIfAborted();
    const file = await toFile(new Uint8Array(request.audio), request.fileName, {
      type: request.mediaType,
    });
    request.signal?.throwIfAborted();

    return this.client.audio.transcriptions.create(
      {
        file,
        model: request.model,
        ...(request.language === undefined ? {} : { language: request.language }),
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        response_format: "verbose_json",
        temperature: 0,
        timestamp_granularities: ["segment"],
      },
      {
        idempotencyKey: request.idempotencyKey,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
  }

  public async createStructuredResponse<T>(
    request: OpenAiStructuredRequest<T>,
  ): Promise<OpenAiStructuredResponse> {
    const response = await this.client.responses.parse(
      {
        model: request.model,
        input: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        max_output_tokens: request.maxOutputTokens,
        store: false,
        text: {
          format: zodTextFormat(request.schema, request.schemaName),
        },
      },
      { idempotencyKey: request.idempotencyKey },
    );

    if (response.output_parsed !== null) {
      return {
        status: "completed",
        parsed: response.output_parsed,
        responseId: response.id,
      };
    }

    for (const item of response.output) {
      if (item.type !== "message") {
        continue;
      }

      for (const content of item.content) {
        if (content.type === "refusal") {
          return {
            status: "refused",
            reason: content.refusal,
            responseId: response.id,
          };
        }
      }
    }

    const incompleteReason = response.incomplete_details?.reason;
    return {
      status: "incomplete",
      reason: incompleteReason ?? `response status: ${response.status}`,
      responseId: response.id,
    };
  }
}
