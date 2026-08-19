import {
  type GeneratedSummary,
  type SummaryGenerationPort,
  type SummaryGenerationRequest,
  type SummaryGenerationResult,
} from "@discord-meeting/meeting-core/meeting-intelligence";

import {
  type AttestationExpectation,
  verifySubscriptionRuntimeAttestation,
} from "./attestation.js";
import {
  RuntimeTaskFailureError,
  SubscriptionRuntimeAdapterError,
  toSubscriptionRuntimePortFailure,
} from "./errors.js";
import { providerMeetingSummarySchema } from "./provider-summary-schema.js";
import {
  buildSubscriptionRuntimeSummaryRequest,
  type SubscriptionRuntimeSummaryRequestOptions,
} from "./request-mapper.js";
import { stableSubscriptionRuntimeId } from "./stable-id.js";
import {
  type BaseSubscriptionRuntimeSummaryAdapterOptions,
  validateAttestationExpectation,
  validateSummaryRequestOptions,
} from "./summary-adapter-options.js";
import { consolidateCoveredUnassignedActions } from "./summary-action-consolidation.js";
import { findPotentiallyTruncatedActionTerms } from "./summary-action-term-postcondition.js";
import {
  mapFinalProviderSummary,
  validateProviderSummaryEvidence,
} from "./summary-output.js";
import {
  type SubscriptionRuntimeTransportPort,
} from "./subscription-runtime-contract.js";

export interface SubscriptionRuntimeSummaryAdapterOptions
  extends BaseSubscriptionRuntimeSummaryAdapterOptions {
  readonly technicalVocabulary?: readonly string[];
}

export interface SubscriptionRuntimeSummaryHealth {
  readonly code:
    | "identity_mismatch"
    | "serving"
    | "transport_failed"
    | "upstream_degraded";
  readonly runtimeVersion?: string;
  readonly status: "degraded" | "not_serving" | "serving";
  readonly verified: boolean;
}

export class SubscriptionRuntimeSummaryAdapter
  implements SummaryGenerationPort
{
  private readonly attestationExpectation: AttestationExpectation;
  private readonly requestOptions: SubscriptionRuntimeSummaryRequestOptions;
  private readonly technicalVocabulary: readonly string[];

  public constructor(
    private readonly transport: SubscriptionRuntimeTransportPort,
    options: SubscriptionRuntimeSummaryAdapterOptions,
  ) {
    this.attestationExpectation = validateAttestationExpectation(options);
    this.requestOptions = validateSummaryRequestOptions(options);
    this.technicalVocabulary = Object.freeze([...(options.technicalVocabulary ?? [])]);
  }

  public async generate(
    request: SummaryGenerationRequest,
  ): Promise<SummaryGenerationResult<GeneratedSummary>> {
    try {
      return { ok: true, value: await this.generateOrThrow(request) };
    } catch (error: unknown) {
      return { ok: false, failure: toSubscriptionRuntimePortFailure(error) };
    }
  }

  public async checkHealth(): Promise<SubscriptionRuntimeSummaryHealth> {
    try {
      const health = await this.transport.checkHealth();
      const identityMatches =
        health.runtimeEngine === this.attestationExpectation.runtimeEngine &&
        health.runtimeVersion ===
          this.attestationExpectation.runtimePackageVersion &&
        health.launcherSha256 === this.attestationExpectation.launcherSha256;
      if (!identityMatches) {
        return {
          code: "identity_mismatch",
          runtimeVersion: health.runtimeVersion,
          status: "not_serving",
          verified: false,
        };
      }
      if (health.status !== "serving") {
        return {
          code: "upstream_degraded",
          runtimeVersion: health.runtimeVersion,
          status: health.status,
          verified: true,
        };
      }
      return {
        code: "serving",
        runtimeVersion: health.runtimeVersion,
        status: "serving",
        verified: true,
      };
    } catch {
      return {
        code: "transport_failed",
        status: "not_serving",
        verified: false,
      };
    }
  }

  private async generateOrThrow(
    request: SummaryGenerationRequest,
  ): Promise<GeneratedSummary> {
    let runtimeRequest = buildSubscriptionRuntimeSummaryRequest(
      request,
      this.requestOptions,
    );
    let result = await this.transport.execute(runtimeRequest);
    assertSupportedProtocolVersion(result);
    let repairedProviderOutput = false;
    if (result.status === "failed" && result.failure.code === "provider_output_invalid") {
      runtimeRequest = providerOutputRepairRequest(runtimeRequest);
      result = await this.transport.execute(runtimeRequest);
      assertSupportedProtocolVersion(result);
      repairedProviderOutput = true;
    }
    if (result.status === "failed") {
      throw new RuntimeTaskFailureError(
        repairedProviderOutput && result.failure.code === "provider_output_invalid"
          ? {
            ...result.failure,
            reconnectRequired: false,
            retryable: false,
          }
          : result.failure,
      );
    }
    if (result.status === "waiting_for_input") {
      throw new SubscriptionRuntimeAdapterError(
        "invalid_provider_response",
        "Subscription runtime requested forbidden interactive input",
      );
    }

    verifySubscriptionRuntimeAttestation(
      runtimeRequest,
      result,
      this.attestationExpectation,
    );
    const parsed = providerMeetingSummarySchema.safeParse(result.structuredOutput);
    if (!parsed.success) {
      throw new SubscriptionRuntimeAdapterError(
        "invalid_provider_response",
        "Subscription runtime returned an invalid meeting summary",
      );
    }
    validateProviderSummaryEvidence(
      parsed.data,
      new Set(request.transcript.turns.map(({ turnId }) => turnId)),
      new Set(request.transcript.turns.map(({ speakerId }) => speakerId)),
    );
    let consolidated = consolidateCoveredUnassignedActions(
      parsed.data,
      request.transcript.turns,
    );
    const potentiallyTruncatedTerms = findPotentiallyTruncatedActionTerms(
      consolidated.actionItems,
      request.transcript.turns,
      this.technicalVocabulary,
    );
    if (potentiallyTruncatedTerms.length > 0) {
      runtimeRequest = actionTermRepairRequest(runtimeRequest, potentiallyTruncatedTerms);
      result = await this.transport.execute(runtimeRequest);
      assertSupportedProtocolVersion(result);
      if (result.status === "failed") {
        throw new RuntimeTaskFailureError(
          result.failure.code === "provider_output_invalid"
            ? { ...result.failure, reconnectRequired: false, retryable: false }
            : result.failure,
        );
      }
      if (result.status === "waiting_for_input") {
        throw new SubscriptionRuntimeAdapterError(
          "invalid_provider_response",
          "Subscription runtime requested forbidden interactive input",
        );
      }
      verifySubscriptionRuntimeAttestation(
        runtimeRequest,
        result,
        this.attestationExpectation,
      );
      const repaired = providerMeetingSummarySchema.safeParse(result.structuredOutput);
      if (!repaired.success) {
        throw new SubscriptionRuntimeAdapterError(
          "invalid_provider_response",
          "Subscription runtime returned an invalid meeting summary",
        );
      }
      validateProviderSummaryEvidence(
        repaired.data,
        new Set(request.transcript.turns.map(({ turnId }) => turnId)),
        new Set(request.transcript.turns.map(({ speakerId }) => speakerId)),
      );
      consolidated = consolidateCoveredUnassignedActions(
        repaired.data,
        request.transcript.turns,
      );
      if (findPotentiallyTruncatedActionTerms(
        consolidated.actionItems,
        request.transcript.turns,
        this.technicalVocabulary,
      ).length > 0) {
        throw new SubscriptionRuntimeAdapterError(
          "invalid_provider_response",
          "Summary action text omitted grounded compound technical terminology",
        );
      }
    }
    return mapFinalProviderSummary(consolidated, request.idempotencyKey);
  }
}

function assertSupportedProtocolVersion(
  result: Awaited<ReturnType<SubscriptionRuntimeTransportPort["execute"]>>,
): void {
  if (result.protocolVersion !== 1) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_provider_response",
      "Subscription runtime returned an unsupported protocol version",
    );
  }
}

function providerOutputRepairRequest(
  request: ReturnType<typeof buildSubscriptionRuntimeSummaryRequest>,
): ReturnType<typeof buildSubscriptionRuntimeSummaryRequest> {
  const runId = stableSubscriptionRuntimeId(
    "summary-provider-output-repair",
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
        "A previous generation failed strict output validation. Regenerate once from the original transcript and obey every schema bound exactly.",
      ].join(" "),
    },
  };
}

function actionTermRepairRequest(
  request: ReturnType<typeof buildSubscriptionRuntimeSummaryRequest>,
  candidateTerms: readonly string[],
): ReturnType<typeof buildSubscriptionRuntimeSummaryRequest> {
  const runId = stableSubscriptionRuntimeId(
    "summary-action-term-repair",
    request.runId,
    ...candidateTerms,
  );
  return {
    ...request,
    context: { ...request.context, correlationId: runId },
    runId,
    task: {
      ...request.task,
      systemPrompt: [
        request.task.systemPrompt,
        "A previous generation may have shortened compound technical terms in an action item. Regenerate once from the original transcript, preserving every grounded term from this exact candidate list in the relevant action text:",
        JSON.stringify(candidateTerms),
      ].join(" "),
    },
  };
}
