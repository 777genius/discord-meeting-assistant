import {
  CoverageExtractionCapacityError,
  type CoverageExtractV1,
  type CoverageExtractorPort,
  type CoverageSelectedTurnV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  type AttestationExpectation,
  verifySubscriptionRuntimeAttestation,
} from "./attestation.js";
import {
  buildSubscriptionRuntimeKnowledgeCoverageRequest,
  coverageEvidenceId,
  knowledgeCoverageRuntimeProfile,
  type KnowledgeCoverageRequestOptions,
} from "./knowledge-coverage-request-mapper.js";
import { providerKnowledgeCoverageExtractSchema } from "./provider-knowledge-schema.js";
import { validateAttestationExpectation } from "./summary-adapter-options.js";
import {
  subscriptionRuntimeKnowledgeCoverageMaxOutputTokens,
  type SubscriptionRuntimeEngine,
  type SubscriptionRuntimeTransportPort,
} from "./subscription-runtime-contract.js";

const defaultIsolatedCwd = "/run/discord-meeting-subscription-runtime/workspace";
const defaultMaximumRequestBytes = 131_072;
const defaultSafeInputTokens = 65_536;
const defaultTimeoutMs = 60_000;

export interface KnowledgeCoverageTokenCounter {
  readonly profile: string;
  countInputTokens(input: string): number;
}

export const utf8ByteUpperBoundKnowledgeCoverageTokenCounter:
  KnowledgeCoverageTokenCounter = Object.freeze({
    countInputTokens: (input: string) => new TextEncoder().encode(input).byteLength,
    profile: "utf8-byte-upper-bound.v1",
  });

export interface SubscriptionRuntimeCoverageExtractorAdapterOptions {
  readonly expectedLauncherSha256: string;
  readonly expectedRuntimeEngine?: SubscriptionRuntimeEngine;
  readonly expectedRuntimePackageVersion?: string;
  readonly isolatedCwd?: string;
  readonly maximumRequestBytes?: number;
  readonly maxOutputTokens?: number;
  readonly safeInputTokens?: number;
  readonly timeoutMs?: number;
  readonly tokenCounter?: KnowledgeCoverageTokenCounter;
}

/** Production every-block semantic extractor over the existing provider boundary. */
export class SubscriptionRuntimeCoverageExtractorAdapter
  implements CoverageExtractorPort
{
  private readonly attestation: AttestationExpectation;
  private readonly maximumRequestBytes: number;
  private readonly requestOptions: KnowledgeCoverageRequestOptions;
  private readonly safeInputTokens: number;
  private readonly tokenCounter: KnowledgeCoverageTokenCounter;
  public readonly profile: string;

  public constructor(
    private readonly transport: SubscriptionRuntimeTransportPort,
    options: SubscriptionRuntimeCoverageExtractorAdapterOptions,
  ) {
    this.attestation = validateAttestationExpectation(options);
    this.requestOptions = validateRequestOptions(options);
    this.maximumRequestBytes = boundedPositiveInteger(
      options.maximumRequestBytes ?? defaultMaximumRequestBytes,
      4_096,
      1_048_576,
      "maximumRequestBytes",
    );
    this.safeInputTokens = boundedPositiveInteger(
      options.safeInputTokens ?? defaultSafeInputTokens,
      1_024,
      262_144,
      "safeInputTokens",
    );
    this.tokenCounter = options.tokenCounter ??
      utf8ByteUpperBoundKnowledgeCoverageTokenCounter;
    this.profile = [
      knowledgeCoverageRuntimeProfile,
      `engine-${this.attestation.runtimeEngine}`,
      `runtime-${this.attestation.runtimePackageVersion}`,
      this.tokenCounter.profile,
      `request-${this.maximumRequestBytes}`,
      `tokens-${this.safeInputTokens}`,
      `timeout-${this.requestOptions.timeoutMs}`,
      `launcher-${options.expectedLauncherSha256}`,
    ].join(":");
  }

  public async extract(
    input: Parameters<CoverageExtractorPort["extract"]>[0],
  ): Promise<CoverageExtractV1> {
    input.signal?.throwIfAborted();
    const request = buildSubscriptionRuntimeKnowledgeCoverageRequest(
      { block: input.block, question: input.question },
      this.requestOptions,
    );
    this.assertCapacity(request);
    let result;
    try {
      result = await this.transport.execute(
        request,
        input.signal === undefined ? {} : { signal: input.signal },
      );
    } catch (error) {
      input.signal?.throwIfAborted();
      throw new Error("semantic coverage extraction transport failed", { cause: error });
    }
    input.signal?.throwIfAborted();
    if (result.protocolVersion !== 1 || result.status !== "completed") {
      throw new Error("semantic coverage extraction did not complete");
    }
    verifySubscriptionRuntimeAttestation(request, result, this.attestation);
    const parsed = providerKnowledgeCoverageExtractSchema.safeParse(
      result.structuredOutput,
    );
    if (!parsed.success) {
      throw new Error("semantic coverage extraction returned a malformed contract");
    }
    const turnsByEvidenceId = new Map(input.block.turns.map((turn, index) => [
      coverageEvidenceId(index),
      turn,
    ]));
    const expectedEvidenceIds = [...turnsByEvidenceId.keys()];
    if (
      parsed.data.reviewedEvidenceIds.length !== expectedEvidenceIds.length ||
      parsed.data.reviewedEvidenceIds.some((evidenceId) =>
        !turnsByEvidenceId.has(evidenceId)
      ) ||
      expectedEvidenceIds.some((evidenceId) =>
        !parsed.data.reviewedEvidenceIds.includes(evidenceId)
      )
    ) {
      throw new Error(
        "semantic coverage extraction did not account for every local turn",
      );
    }
    const selectedTurns = parsed.data.claims.flatMap(({ evidenceIds, relevance }) =>
      evidenceIds.map((evidenceId): CoverageSelectedTurnV1 => {
        const turn = turnsByEvidenceId.get(evidenceId);
        if (turn === undefined) {
          throw new Error("semantic coverage extraction cited an unknown local turn");
        }
        return Object.freeze({
          blockLocator: input.block.candidateLocator,
          relevance,
          turnId: turn.turnId,
        });
      })
    );
    if (
      selectedTurns.length > input.block.turns.length ||
      new Set(selectedTurns.map(({ turnId }) => turnId)).size !== selectedTurns.length ||
      (parsed.data.status === "claims") !== (selectedTurns.length > 0)
    ) {
      throw new Error("semantic coverage extraction omitted or duplicated claim references");
    }
    return Object.freeze({
      blockLocator: input.block.candidateLocator,
      evidenceLocators: Object.freeze(selectedTurns.length === 0
        ? []
        : [input.block.candidateLocator]),
      payload: Object.freeze({
        blocksReviewed: 1,
        selectedTurnCount: selectedTurns.length,
        semanticClaimCount: parsed.data.claims.length,
        turnsReviewed: parsed.data.reviewedEvidenceIds.length,
      }),
      selectedTurns: Object.freeze(selectedTurns),
      selectionStatus: selectedTurns.length === 0 ? "no_match" : "selected",
      schemaVersion: 1,
    });
  }

  private assertCapacity(
    request: ReturnType<typeof buildSubscriptionRuntimeKnowledgeCoverageRequest>,
  ): void {
    const serialized = JSON.stringify(request);
    const requestBytes = new TextEncoder().encode(serialized).byteLength;
    const inputTokens = this.tokenCounter.countInputTokens([
      request.task.systemPrompt,
      request.task.prompt,
      JSON.stringify(request.task.controls.outputSchema),
    ].join("\n"));
    if (
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 1 ||
      requestBytes > this.maximumRequestBytes ||
      inputTokens > this.safeInputTokens
    ) {
      throw new CoverageExtractionCapacityError(
        "semantic coverage block exceeds its qualified provider budget",
      );
    }
  }
}

function validateRequestOptions(
  options: SubscriptionRuntimeCoverageExtractorAdapterOptions,
): KnowledgeCoverageRequestOptions {
  return {
    isolatedCwd: options.isolatedCwd ?? defaultIsolatedCwd,
    maxOutputTokens: options.maxOutputTokens ??
      subscriptionRuntimeKnowledgeCoverageMaxOutputTokens,
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
  };
}

function boundedPositiveInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} is outside its qualified range`);
  }
  return value;
}
