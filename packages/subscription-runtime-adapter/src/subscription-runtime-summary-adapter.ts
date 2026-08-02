import type {
  GeneratedSummary,
  PortResult,
  SummaryGenerationPort,
  SummaryGenerationRequest,
} from "@discord-meeting/meeting-core";

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
import {
  type BaseSubscriptionRuntimeSummaryAdapterOptions,
  validateAttestationExpectation,
  validateSummaryRequestOptions,
} from "./summary-adapter-options.js";
import {
  mapFinalProviderSummary,
  validateProviderSummaryEvidence,
} from "./summary-output.js";
import {
  subscriptionRuntimeEngine,
  type SubscriptionRuntimeTransportPort,
} from "./subscription-runtime-contract.js";

export interface SubscriptionRuntimeSummaryAdapterOptions
  extends BaseSubscriptionRuntimeSummaryAdapterOptions {}

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

  public constructor(
    private readonly transport: SubscriptionRuntimeTransportPort,
    options: SubscriptionRuntimeSummaryAdapterOptions,
  ) {
    this.attestationExpectation = validateAttestationExpectation(options);
    this.requestOptions = validateSummaryRequestOptions(options);
  }

  public async generate(
    request: SummaryGenerationRequest,
  ): Promise<PortResult<GeneratedSummary>> {
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
        health.runtimeEngine === subscriptionRuntimeEngine &&
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
    const runtimeRequest = buildSubscriptionRuntimeSummaryRequest(
      request,
      this.requestOptions,
    );
    const result = await this.transport.execute(runtimeRequest);
    if (result.protocolVersion !== 1) {
      throw new SubscriptionRuntimeAdapterError(
        "invalid_provider_response",
        "Subscription runtime returned an unsupported protocol version",
      );
    }
    if (result.status === "failed") {
      throw new RuntimeTaskFailureError(result.failure);
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
    return mapFinalProviderSummary(parsed.data, request.idempotencyKey);
  }
}
