import type {
  GeneratedSummary,
  PortResult,
  SummaryGenerationPort,
  SummaryGenerationRequest,
  TranscriptTurnSnapshot,
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
import {
  type ProviderMeetingSummary,
  providerMeetingSummarySchema,
} from "./provider-summary-schema.js";
import {
  buildSubscriptionRuntimeSummaryRequest,
  type SubscriptionRuntimeSummaryRequestOptions,
} from "./request-mapper.js";
import { stableSubscriptionRuntimeId } from "./stable-id.js";
import {
  auditedSubscriptionRuntimePackageVersion,
  subscriptionRuntimeEngine,
  type SubscriptionRuntimeTransportPort,
} from "./subscription-runtime-contract.js";

const defaultIsolatedCwd = "/run/discord-meeting-subscription-runtime/workspace";
const defaultMaxOutputTokens = 4_096;
const defaultMaxPromptBytes = 2 * 1_024 * 1_024;
const defaultTimeoutMs = 600_000;

export interface SubscriptionRuntimeSummaryAdapterOptions {
  readonly expectedLauncherSha256: string;
  readonly expectedRuntimePackageVersion?: string;
  readonly isolatedCwd?: string;
  readonly maxOutputTokens?: number;
  readonly maxPromptBytes?: number;
  readonly outputLanguage?: string;
  readonly timeoutMs?: number;
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

  public constructor(
    private readonly transport: SubscriptionRuntimeTransportPort,
    options: SubscriptionRuntimeSummaryAdapterOptions,
  ) {
    this.attestationExpectation = validateAttestationExpectation(options);
    this.requestOptions = validateRequestOptions(options);
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
    validateEvidence(parsed.data, request.transcript.turns);
    return mapSummary(parsed.data, request.idempotencyKey);
  }
}

function validateAttestationExpectation(
  options: SubscriptionRuntimeSummaryAdapterOptions,
): AttestationExpectation {
  if (!/^[0-9a-f]{64}$/u.test(options.expectedLauncherSha256)) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_input",
      "expectedLauncherSha256 must be a lowercase SHA-256 digest",
    );
  }
  const runtimePackageVersion =
    options.expectedRuntimePackageVersion ??
    auditedSubscriptionRuntimePackageVersion;
  if (
    runtimePackageVersion !== auditedSubscriptionRuntimePackageVersion
  ) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_input",
      `Only audited subscription runtime ${auditedSubscriptionRuntimePackageVersion} is admitted`,
    );
  }
  return {
    launcherSha256: options.expectedLauncherSha256,
    runtimePackageVersion,
  };
}

function validateRequestOptions(
  options: SubscriptionRuntimeSummaryAdapterOptions,
): SubscriptionRuntimeSummaryRequestOptions {
  const isolatedCwd = options.isolatedCwd ?? defaultIsolatedCwd;
  if (!isolatedCwd.startsWith("/") || isolatedCwd.includes("\0")) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_input",
      "isolatedCwd must be an absolute safe path",
    );
  }
  const outputLanguage = options.outputLanguage?.trim();
  if (options.outputLanguage !== undefined && outputLanguage?.length === 0) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_input",
      "outputLanguage must not be empty",
    );
  }
  return {
    isolatedCwd,
    maxOutputTokens: positiveIntegerOption(
      options.maxOutputTokens,
      defaultMaxOutputTokens,
      256,
      32_768,
      "maxOutputTokens",
    ),
    maxPromptBytes: positiveIntegerOption(
      options.maxPromptBytes,
      defaultMaxPromptBytes,
      1_024,
      16 * 1_024 * 1_024,
      "maxPromptBytes",
    ),
    timeoutMs: positiveIntegerOption(
      options.timeoutMs,
      defaultTimeoutMs,
      1_000,
      3_600_000,
      "timeoutMs",
    ),
    ...(outputLanguage === undefined ? {} : { outputLanguage }),
  };
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_input",
      `${field} must be a safe integer from ${minimum} through ${maximum}`,
    );
  }
  return resolved;
}

function validateEvidence(
  summary: ProviderMeetingSummary,
  turns: readonly TranscriptTurnSnapshot[],
): void {
  const knownTurnIds = new Set(turns.map((turn) => turn.turnId));
  const knownSpeakerIds = new Set(turns.map((turn) => turn.speakerId));
  const evidenceGroups = [
    ...summary.decisions.map((decision) => decision.evidenceTurnIds),
    ...summary.actionItems.map((actionItem) => actionItem.evidenceTurnIds),
  ];
  for (const evidenceTurnIds of evidenceGroups) {
    if (new Set(evidenceTurnIds).size !== evidenceTurnIds.length) {
      throw new SubscriptionRuntimeAdapterError(
        "invalid_evidence",
        "Summary evidence references must not contain duplicates",
      );
    }
    if (evidenceTurnIds.some((turnId) => !knownTurnIds.has(turnId))) {
      throw new SubscriptionRuntimeAdapterError(
        "invalid_evidence",
        "Summary references a transcript turn that does not exist",
      );
    }
  }
  if (
    summary.actionItems.some(
      ({ ownerSpeakerId }) =>
        ownerSpeakerId !== null && !knownSpeakerIds.has(ownerSpeakerId),
    )
  ) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_evidence",
      "Summary action owner is not a transcript speaker",
    );
  }
}

function mapSummary(
  summary: ProviderMeetingSummary,
  idempotencyKey: string,
): GeneratedSummary {
  return {
    actionItems: summary.actionItems.map((actionItem, index) => ({
      actionItemId: stableSubscriptionRuntimeId(
        "action",
        idempotencyKey,
        String(index + 1),
      ),
      evidenceTurnIds: [...actionItem.evidenceTurnIds],
      ownerSpeakerId: actionItem.ownerSpeakerId,
      text: actionItem.text,
    })),
    decisions: summary.decisions.map((decision, index) => ({
      decisionId: stableSubscriptionRuntimeId(
        "decision",
        idempotencyKey,
        String(index + 1),
      ),
      evidenceTurnIds: [...decision.evidenceTurnIds],
      text: decision.text,
    })),
    openQuestions: [...summary.openQuestions],
    overview: summary.overview,
    summaryId: stableSubscriptionRuntimeId("summary", idempotencyKey),
    title: summary.title,
    version: 1,
  };
}
