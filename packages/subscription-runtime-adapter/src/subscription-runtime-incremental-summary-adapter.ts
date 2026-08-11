import {
  type GeneratedIncrementalSummary,
  type IncrementalSummaryGenerationPort,
  type IncrementalSummaryGenerationResult,
  type IncrementalSummaryGenerationRequest,
  type LiveGenerationTelemetrySnapshot,
  type LiveGenerationUsageSnapshot,
} from "@discord-meeting/meeting-core/live-meeting";

import {
  type AttestationExpectation,
  verifySubscriptionRuntimeAttestation,
} from "./attestation.js";
import {
  RuntimeTaskFailureError,
  SubscriptionRuntimeAdapterError,
  toSubscriptionRuntimePortFailure,
} from "./errors.js";
import {
  buildSubscriptionRuntimeIncrementalSummaryRequest,
  type SubscriptionRuntimeIncrementalSummaryRequestOptions,
} from "./incremental-request-mapper.js";
import { createIncrementalEvidenceAliases } from "./incremental-evidence-aliases.js";
import {
  mapLunaGenerationTelemetry,
  mapLunaGenerationUsage,
} from "./luna-price-card.js";
import { providerIncrementalMeetingSummarySchema } from "./provider-summary-schema.js";
import {
  type BaseSubscriptionRuntimeSummaryAdapterOptions,
  positiveIntegerOption,
  validateAttestationExpectation,
  validateIncrementalSummaryRequestOptions,
} from "./summary-adapter-options.js";
import {
  mapIncrementalProviderSummary,
  validateIncrementalSummaryRetention,
  validateProviderSummaryEvidence,
} from "./summary-output.js";
import type { SubscriptionRuntimeTransportPort } from "./subscription-runtime-contract.js";

const defaultMaxRecentContextTurns = 256;

export interface SubscriptionRuntimeIncrementalSummaryAdapterOptions
  extends BaseSubscriptionRuntimeSummaryAdapterOptions {
  readonly maxRecentContextTurns?: number;
}

export class SubscriptionRuntimeIncrementalSummaryAdapter
  implements IncrementalSummaryGenerationPort
{
  private readonly attestationExpectation: AttestationExpectation;
  private readonly requestOptions: SubscriptionRuntimeIncrementalSummaryRequestOptions;

  public constructor(
    private readonly transport: SubscriptionRuntimeTransportPort,
    options: SubscriptionRuntimeIncrementalSummaryAdapterOptions,
  ) {
    this.attestationExpectation = validateAttestationExpectation(options);
    this.requestOptions = {
      ...validateIncrementalSummaryRequestOptions(options),
      maxRecentContextTurns: positiveIntegerOption(
        options.maxRecentContextTurns,
        defaultMaxRecentContextTurns,
        1,
        2_048,
        "maxRecentContextTurns",
      ),
    };
  }

  public async generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<IncrementalSummaryGenerationResult> {
    let telemetry: LiveGenerationTelemetrySnapshot | undefined;
    let usage: LiveGenerationUsageSnapshot | undefined;
    try {
      const value = await this.generateOrThrow(
        request,
        (capturedTelemetry) => {
          telemetry = capturedTelemetry;
        },
        (capturedUsage) => {
          usage = capturedUsage;
        },
      );
      return { ok: true, value };
    } catch (error: unknown) {
      return {
        ok: false,
        failure: toSubscriptionRuntimePortFailure(error),
        ...(telemetry === undefined ? {} : { telemetry }),
        ...(usage === undefined ? {} : { usage }),
      };
    }
  }

  private async generateOrThrow(
    request: IncrementalSummaryGenerationRequest,
    captureTelemetry: (telemetry: LiveGenerationTelemetrySnapshot) => void,
    captureUsage: (usage: LiveGenerationUsageSnapshot) => void,
  ): Promise<GeneratedIncrementalSummary> {
    const runtimeRequest = buildSubscriptionRuntimeIncrementalSummaryRequest(
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
    if (result.status === "waiting_for_input") {
      throw new SubscriptionRuntimeAdapterError(
        "invalid_provider_response",
        "Subscription runtime requested forbidden interactive input",
      );
    }
    const usage = result.usage === undefined
      ? undefined
      : mapLunaGenerationUsage(result.usage, runtimeRequest.runId);
    const telemetry = result.telemetry === undefined
      ? undefined
      : mapLunaGenerationTelemetry(result.telemetry, runtimeRequest.runId);
    if (telemetry !== undefined) {
      captureTelemetry(telemetry);
    }
    if (usage !== undefined) {
      captureUsage(usage);
    }
    if (result.status === "failed") {
      throw new RuntimeTaskFailureError(result.failure);
    }
    if (telemetry === undefined && usage === undefined) {
      throw new SubscriptionRuntimeAdapterError(
        "telemetry_unavailable",
        "Subscription runtime did not return generation telemetry",
      );
    }
    verifySubscriptionRuntimeAttestation(
      runtimeRequest,
      result,
      this.attestationExpectation,
    );
    const parsed = providerIncrementalMeetingSummarySchema.safeParse(
      result.structuredOutput,
    );
    if (!parsed.success) {
      throw new SubscriptionRuntimeAdapterError(
        "invalid_provider_response",
        "Subscription runtime returned an invalid meeting summary",
      );
    }
    const canonicalSummary = createIncrementalEvidenceAliases(request)
      .restoreSummary(parsed.data);
    validateProviderSummaryEvidence(
      canonicalSummary,
      new Set(request.knownTurnIds),
      new Set(request.knownSpeakerIds),
    );
    validateIncrementalSummaryRetention(canonicalSummary, request.previousSummary);
    return {
      summary: mapIncrementalProviderSummary(
        canonicalSummary,
        request.idempotencyKey,
        request.revision,
      ),
      ...(telemetry === undefined ? {} : { telemetry }),
      ...(usage === undefined ? {} : { usage }),
    };
  }
}
