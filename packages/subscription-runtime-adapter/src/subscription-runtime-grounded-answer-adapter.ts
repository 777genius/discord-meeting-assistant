import type {
  GroundedAnswerGenerationRequest,
  GroundedAnswerGenerationResult,
  GroundedAnswerGenerator,
  GroundedAnswerMeasurement,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  type AttestationExpectation,
  verifySubscriptionRuntimeAttestation,
} from "./attestation.js";
import {
  buildSubscriptionRuntimeKnowledgeAnswerRequest,
  knowledgeAnswerRuntimeProfile,
  type KnowledgeAnswerRequestOptions,
} from "./knowledge-answer-request-mapper.js";
import { providerKnowledgeAnswerSchema } from "./provider-knowledge-schema.js";
import { stableSubscriptionRuntimeId } from "./stable-id.js";
import {
  validateAttestationExpectation,
} from "./summary-adapter-options.js";
import {
  subscriptionRuntimeKnowledgeAnswerMaxOutputTokens,
  type SubscriptionRuntimeEngine,
  type SubscriptionRuntimeTransportPort,
} from "./subscription-runtime-contract.js";

const defaultIsolatedCwd = "/run/discord-meeting-subscription-runtime/workspace";
const defaultTimeoutMs = 180_000;

export interface KnowledgeAnswerTokenCounter {
  readonly profile: string;
  countInputTokens(input: string): number;
}

/**
 * Fail-safe production fallback while the exact Sol tokenizer is not available
 * locally: every UTF-8 byte consumes one budget unit, which cannot undercount a
 * normal text token. Its distinct profile keeps qualification evidence honest.
 */
export const utf8ByteUpperBoundKnowledgeTokenCounter: KnowledgeAnswerTokenCounter =
  Object.freeze({
    countInputTokens: (input: string) => new TextEncoder().encode(input).byteLength,
    profile: "utf8-byte-upper-bound.v1",
  });

export interface SubscriptionRuntimeGroundedAnswerAdapterOptions {
  readonly expectedLauncherSha256: string;
  readonly expectedRuntimeEngine?: SubscriptionRuntimeEngine;
  readonly expectedRuntimePackageVersion?: string;
  readonly isolatedCwd?: string;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly tokenCounter?: KnowledgeAnswerTokenCounter;
}

export class SubscriptionRuntimeGroundedAnswerAdapter
  implements GroundedAnswerGenerator
{
  private readonly attestation: AttestationExpectation;
  private readonly requestOptions: KnowledgeAnswerRequestOptions;
  private readonly tokenCounter: KnowledgeAnswerTokenCounter;

  public constructor(
    private readonly transport: SubscriptionRuntimeTransportPort,
    options: SubscriptionRuntimeGroundedAnswerAdapterOptions,
  ) {
    this.attestation = validateAttestationExpectation(options);
    this.requestOptions = validateRequestOptions(options);
    this.tokenCounter = options.tokenCounter ?? utf8ByteUpperBoundKnowledgeTokenCounter;
  }

  public async measure(
    request: GroundedAnswerGenerationRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<GroundedAnswerMeasurement> {
    options.signal?.throwIfAborted();
    const runtimeRequest = this.build(request);
    const input = inputSurface(runtimeRequest);
    const inputTokens = this.tokenCounter.countInputTokens(input);
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 1) {
      throw new Error("knowledge input token counter returned an invalid measurement");
    }
    return {
      inputTokens,
      requestBytes: new TextEncoder().encode(JSON.stringify(runtimeRequest)).byteLength,
      runtimeProfile: `${knowledgeAnswerRuntimeProfile}:${this.tokenCounter.profile}`,
    };
  }

  public async generate(
    request: GroundedAnswerGenerationRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<GroundedAnswerGenerationResult> {
    options.signal?.throwIfAborted();
    let runtimeRequest = this.build(request);
    let repairedProviderOutput = false;
    let result;
    try {
      result = await this.transport.execute(runtimeRequest, options);
      if (
        result.protocolVersion === 1 &&
        result.status === "failed" &&
        result.failure.code === "provider_output_invalid"
      ) {
        options.signal?.throwIfAborted();
        runtimeRequest = providerOutputRepairRequest(runtimeRequest);
        result = await this.transport.execute(runtimeRequest, options);
        repairedProviderOutput = true;
      }
    } catch {
      options.signal?.throwIfAborted();
      return { code: "runtime_unavailable", retryable: true, status: "failed" };
    }
    if (result.protocolVersion !== 1) {
      return invalidOutput("unsupported_protocol");
    }
    if (result.status === "waiting_for_input") {
      return invalidOutput("interactive_input_forbidden");
    }
    if (result.status === "failed") {
      return {
        code: result.failure.code,
        retryable: repairedProviderOutput &&
            result.failure.code === "provider_output_invalid"
          ? false
          : result.failure.retryable || result.failure.reconnectRequired,
        status: "failed",
      };
    }
    try {
      verifySubscriptionRuntimeAttestation(runtimeRequest, result, this.attestation);
      const parsed = providerKnowledgeAnswerSchema.safeParse(result.structuredOutput);
      return parsed.success
        ? { answer: parsed.data, status: "completed" }
        : invalidOutput("provider_output_invalid");
    } catch {
      return invalidOutput("invalid_attestation");
    }
  }

  private build(request: GroundedAnswerGenerationRequest) {
    return buildSubscriptionRuntimeKnowledgeAnswerRequest(request, this.requestOptions);
  }
}

function providerOutputRepairRequest(
  request: ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest>,
): ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest> {
  const runId = stableSubscriptionRuntimeId(
    "knowledge-answer-provider-output-repair",
    request.runId,
  );
  return {
    ...request,
    context: {
      ...request.context,
      correlationId: runId,
    },
    runId,
    task: {
      ...request.task,
      systemPrompt: [
        request.task.systemPrompt,
        "A previous generation failed strict output validation. Regenerate once from the original supplied question and evidence and obey every schema bound exactly.",
        "In particular, claims=[] with status=answered is forbidden. Decide answerability before emitting claims: for an answerable question populate claims with at least one concise supported claim and its direct evidenceIds, then emit status=answered; otherwise keep claims=[] and emit insufficient_evidence or not_a_question.",
      ].join(" "),
    },
  };
}

function inputSurface(
  request: ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest>,
): string {
  return [
    request.task.systemPrompt,
    request.task.prompt,
    JSON.stringify(request.task.controls.outputSchema),
  ].join("\n");
}

function invalidOutput(code: string): GroundedAnswerGenerationResult {
  return { code, retryable: false, status: "failed" };
}

function validateRequestOptions(
  options: SubscriptionRuntimeGroundedAnswerAdapterOptions,
): KnowledgeAnswerRequestOptions {
  const isolatedCwd = options.isolatedCwd ?? defaultIsolatedCwd;
  const maxOutputTokens = options.maxOutputTokens ??
    subscriptionRuntimeKnowledgeAnswerMaxOutputTokens;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (
    !isolatedCwd.startsWith("/") ||
    isolatedCwd.includes("\0") ||
    maxOutputTokens !== subscriptionRuntimeKnowledgeAnswerMaxOutputTokens ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 300_000
  ) {
    throw new Error("knowledge answer options conflict with the pinned runtime profile");
  }
  return { isolatedCwd, maxOutputTokens, timeoutMs };
}
