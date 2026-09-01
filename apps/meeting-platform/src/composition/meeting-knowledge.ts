import {
  DiscordAnswerDeliveryAdapter, DiscordAnswerPayloadCodec,
  DiscordGroundedAnswerRenderer, DiscordHistoricalAuthorizationAdapter,
  DiscordLocalFinalReplyHandler, DiscordQuestionAuthorizationAdapter,
  DiscordQuestionPrincipalCodec, DiscordConfusableIdentitySkeletons,
  createDiscordOneAttemptAnswerRest,
  decodeDiscordQuestionPrincipalKey,
  discordParticipantQuestionPolicyVersion,
  type DiscordLocalFinalReplyHandlerOptions,
  type DiscordQuestionScopePort,
} from "@discord-meeting/discord-adapter";
import {
  AdmitCurrentFinalReply,
  GroundedMeetingAnswer,
  HistoricalExhaustiveMemoryRetrieval,
  MaintainFinalReplies,
  ProcessFinalReplyJob, qualifiedFocusedEvidenceCandidateLimit,
  type LocalFinalReplyPolicy,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { DurableAnswerPublication, type AnswerDeliveryPort } from
  "@discord-meeting/meeting-core/publishing";
import type { Logger } from "@discord-meeting/observability-adapter";
import {
  PostgresAnswerEffectStore,
  PostgresFinalReplyMaintenance,
  canonicalFinalReplyTurnHash,
  PostgresFinalReplyEvidence,
  PostgresFocusedMemoryRetrieval,
  PostgresMeetingSourceConfigurationRepository,
  PostgresQuestionAdmissionCommit,
  PostgresQuestionJobStore,
} from "@discord-meeting/postgres-adapter";
import type { SubscriptionRuntimeTransportPort } from
  "@discord-meeting/subscription-runtime-adapter";
import type { Client } from "discord.js";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { TestOnlyAnswerDeliveryCrashInjection } from
  "../adapters/outbound/test-only-answer-delivery-crash-injection.js";

import type { PlatformConfig } from "../config.js";
import { participantSpeakerAliases } from "../config/participant-greeting-profiles.js";
import { classifyPlatformError } from "./observability.js";
import type { PlatformHistoricalMemoryRuntime } from "./historical-memory.js";
import { createPersistedFocusedMemoryRoute } from "./meeting-knowledge-retrieval-router.js";
import { createFocusedEvidenceSelector, createGroundedAnswerGenerator } from
  "./meeting-knowledge-provider-composition.js";
import { createMeetingKnowledgePollingRuntime,
  type MeetingKnowledgeLocalFinalReplyRuntime } from
  "./meeting-knowledge-polling-runtime.js";
export { createMeetingKnowledgePollingRuntime, MeetingKnowledgeDrainTimeoutError } from
  "./meeting-knowledge-polling-runtime.js";
export type { MeetingKnowledgeLocalFinalReplyRuntime } from
  "./meeting-knowledge-polling-runtime.js";

const meetingKnowledgeProviderLeasePolicy = Object.freeze({
  focusedEvidenceSelectorTimeoutMilliseconds: 60_000,
  groundedAnswerTimeoutMilliseconds: 180_000, maximumGroundedAnswerExecutions: 2,
  safetyMilliseconds: 120_000,
});
const providerAttemptLeaseSeconds = (
  meetingKnowledgeProviderLeasePolicy.focusedEvidenceSelectorTimeoutMilliseconds +
  (meetingKnowledgeProviderLeasePolicy.maximumGroundedAnswerExecutions *
    meetingKnowledgeProviderLeasePolicy.groundedAnswerTimeoutMilliseconds) +
  meetingKnowledgeProviderLeasePolicy.safetyMilliseconds) / 1_000;

export const meetingKnowledgeRetrievalProfilePreimages = Object.freeze({
  composite: Object.freeze({
    candidatePolicy: "bounded-lane-round-robin-dedupe.v1",
    historicalLane: "infinity-context-retrieval-v2-exact-request",
    interleavePolicy: "local-then-historical-per-rank.v1",
    localLane: "canonical-local-exact-lexical-v1",
    maximumCandidates: qualifiedFocusedEvidenceCandidateLimit,
    profileId: "meeting-knowledge.composite-retrieval.v1",
    provenanceVerification: "request-result-lane-accounting.v2", version: 1,
  }),
  infinity: Object.freeze({
    authoritySnapshot: "repeatable-read-cursor-room-snapshot.v1",
    candidateIsolation: "malformed-candidate-only;batch-overflow-churn-abort",
    contract: "context-retrieval.v2", digestCanonicalization: "utf8-lexicographic-json.v1",
    evidenceByteLimit: 16_000, path: "infinity_locator_v2",
    provenance: "exact-request-response-digests-and-lane-accounting.v2",
    rankingPolicy: "weighted_rrf_canonical_preferences.v1", version: 2,
  }),
  local: Object.freeze({
    algorithm: "nfkc-lowercase-token-exact-match-balanced-speaker-minute.v1",
    candidateLimit: 100, digestCanonicalization: "utf8-lexicographic-json.v1",
    evidenceByteLimit: 16_000,
    hardFilters: "sealed-speaker-and-relative-time-overlap.v1",
    path: "canonical_local_exact_lexical_v1",
    profileId: "meeting-knowledge.local-current.v2",
    provenance: "exact-original-question-request-result-digests.v2",
    queryTermPolicy: "temporal-scaffolding-stop-terms.v2", resultLimit: 10, version: 2,
  }),
});

export function retrievalProfileFingerprint(preimage: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalProfileValue(preimage)), "utf8")
    .digest("hex");
}

function canonicalProfileValue(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonicalProfileValue);}
  if (typeof value !== "object" || value === null) {return value;}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, nested]) => [key, canonicalProfileValue(nested)]));
}

/**
 * This ledger is deliberately co-located with composition policy. Any change
 * requires replay of the retained focused-retrieval and two-hour corpora.
 */
export const localFinalReplyPolicy: LocalFinalReplyPolicy = Object.freeze({
  admission: Object.freeze({
    guildQuestionsPerHour: 120,
    jobTtlSeconds: 900,
    requesterQuestionsPerHour: 6,
  }),
  answerMessageMaximumCharacters: 2_000,
  authorizationPolicyVersion: discordParticipantQuestionPolicyVersion,
  groundingSafety: Object.freeze({
    maximumRequestBytes: 1_572_864,
    modelContextTokens: 400_000,
    outputTokensReserved: 2_048,
    reasoningTokensReserved: 32_768,
    safeInputTokens: 300_000,
    tokenDriftReserve: 32_768,
  }),
  // One reservation spans selector, answer generation, and at most one
  // provider-output repair execution. Keep both answer deadlines plus bounded
  // orchestration slack inside the durable lease.
  jobLeaseSeconds: providerAttemptLeaseSeconds,
  maximumProviderAttempts: 2,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v4",
  retrieval: Object.freeze({ maximumCandidates: qualifiedFocusedEvidenceCandidateLimit, neighborTurns: 2 }),
  retrievalAdmission: Object.freeze({
    compositeProfileFingerprint: retrievalProfileFingerprint(
      meetingKnowledgeRetrievalProfilePreimages.composite,
    ),
    cutoverEpoch: "composite-retrieval-authority-r3",
    infinityProfileFingerprint: retrievalProfileFingerprint(
      meetingKnowledgeRetrievalProfilePreimages.infinity,
    ),
    localProfileFingerprint: retrievalProfileFingerprint(
      meetingKnowledgeRetrievalProfilePreimages.local,
    ),
  }),
});

const localFinalReplyPolicyRelease = Object.freeze({
  authorizationPolicyVersion: localFinalReplyPolicy.authorizationPolicyVersion, policyEpoch: 4,
  policyVersion: localFinalReplyPolicy.policyVersion,
});

function discordQuestionIngressOptions(
  config: PlatformConfig,
): DiscordLocalFinalReplyHandlerOptions {
  const actorIds = config.meetingKnowledge?.e2eSyntheticHumanActorIds;
  return {
    ...(actorIds === undefined
      ? {}
      : { e2eSyntheticHumanAuthorIds: actorIds }),
    principalTtlSeconds: localFinalReplyPolicy.admission.jobTtlSeconds,
  };
}

function createRetrievalV2Admission(
  historicalMemory: PlatformHistoricalMemoryRuntime | undefined,
  config: PlatformConfig,
) {
  const binding = config.meetingKnowledge?.retrievalV2ProviderBinding;
  return binding === undefined || historicalMemory === undefined
    ? undefined
    : historicalMemory.createRetrievalV2Admission(binding);
}

export function meetingKnowledgeLocalServingEnabled(
  config: PlatformConfig, historicalRuntimeAvailable: boolean,
): boolean {
  return config.meetingKnowledge?.localFinalReply === true && (
    config.meetingKnowledge.retrievalV2ProviderBinding === undefined ||
    historicalRuntimeAvailable);
}

class ConfiguredDiscordQuestionScope implements DiscordQuestionScopePort {
  public constructor(
    private readonly configurations: PostgresMeetingSourceConfigurationRepository,
  ) {}

  public async resultsContainerForGuild(guildId: string): Promise<string | null> {
    const configuration = await this.configurations.findBySourceId(guildId);
    return configuration?.status === "active"
      ? configuration.publicationTargetId
      : null;
  }
}

export function createMeetingKnowledgeLocalFinalReply(input: {
  readonly answerDelivery?: AnswerDeliveryPort;
  readonly answers?: GroundedMeetingAnswer;
  readonly client: Client;
  readonly config: PlatformConfig;
  readonly sourceConfigurations: PostgresMeetingSourceConfigurationRepository;
  readonly historicalMemory?: PlatformHistoricalMemoryRuntime;
  readonly logger: Logger;
  readonly pool: Pool;
  readonly runtimeTransport: SubscriptionRuntimeTransportPort;
}): MeetingKnowledgeLocalFinalReplyRuntime {
  const servingEnabled = meetingKnowledgeLocalServingEnabled(
    input.config,
    input.historicalMemory !== undefined,
  );
  const jobs = new PostgresQuestionJobStore(input.pool, localFinalReplyPolicyRelease);
  const baseDelivery = input.answerDelivery ?? new DiscordAnswerDeliveryAdapter(
      createDiscordOneAttemptAnswerRest(input.config.secrets.discordToken),
      input.config.discordApplicationId,
    );
  const crash = input.config.testOnly?.publicReplyCrashInjection;
  const publication = new DurableAnswerPublication({
    delivery: crash === undefined ? baseDelivery
      : new TestOnlyAnswerDeliveryCrashInjection(baseDelivery, crash.root, crash.workerId),
    payloads: new DiscordAnswerPayloadCodec(),
    store: new PostgresAnswerEffectStore(input.pool, localFinalReplyPolicyRelease),
  });
  const maintenance = new MaintainFinalReplies(
    new PostgresFinalReplyMaintenance(input.pool, localFinalReplyPolicyRelease),
    servingEnabled,
  );
  const reportError = (error: unknown): void => {
    input.logger.error(
      "Meeting Knowledge local final reply operation failed",
      classifyPlatformError(error),
    );
  };
  const reportDuplicateContainment = (count: number): void => {
    input.logger.warn(
      "Meeting Knowledge contained duplicate answer receipts",
      { containedEffects: count },
    );
  };
  if (!servingEnabled) {
    return createMeetingKnowledgePollingRuntime({
      maintenance,
      publication,
      reportDuplicateContainment,
      reportError,
    });
  }
  const meetingKnowledgeConfig = input.config.meetingKnowledge;
  if (meetingKnowledgeConfig === undefined) {throw new Error(
    "Meeting Knowledge serving configuration is unavailable");}

  const secret = input.config.secrets.meetingKnowledgePrincipalKey;
  if (secret === undefined) {
    throw new Error("Meeting Knowledge principal key is missing from validated config");
  }
  const principals = new DiscordQuestionPrincipalCodec(
    decodeDiscordQuestionPrincipalKey(secret),
  );
  const evidence = new PostgresFinalReplyEvidence(
    input.pool,
    input.config.discordApplicationId,
  );
  const admissions = new PostgresQuestionAdmissionCommit(
    input.pool,
    input.config.discordApplicationId,
    localFinalReplyPolicyRelease,
  );
  const authorization = new DiscordQuestionAuthorizationAdapter(
    input.client,
    principals,
  );
  const currentMemory = new PostgresFocusedMemoryRetrieval(
    input.pool,
    input.config.discordApplicationId,
  );
  const historicalAuthorization = input.historicalMemory === undefined
    ? undefined
    : new DiscordHistoricalAuthorizationAdapter(input.client, principals);
  const memory = createPersistedFocusedMemoryRoute({
    current: currentMemory,
    ...(input.historicalMemory === undefined || historicalAuthorization === undefined
      ? {} : {
          retrievalV2Historical:
            input.historicalMemory.createFocusedLocatorRetrievalV2(
              historicalAuthorization,
            ),
        }),
  });
  const retrievalV2Admission = createRetrievalV2Admission(
    input.historicalMemory, input.config,
  );
  const admission = new AdmitCurrentFinalReply(
    evidence,
    authorization,
    admissions,
    Object.freeze({
      ...localFinalReplyPolicy,
      retrievalAdmission: Object.freeze({
        ...localFinalReplyPolicy.retrievalAdmission,
        ...(meetingKnowledgeConfig.retrievalV2ProviderBinding === undefined
          ? {}
          : { retrievalV2ProviderBinding:
              meetingKnowledgeConfig.retrievalV2ProviderBinding }),
      }),
    }),
    Object.freeze({
      canonicalSpeakerFilters: Object.freeze({
        aliases: participantSpeakerAliases(input.config.participantGreetingProfiles),
        identitySkeletons: new DiscordConfusableIdentitySkeletons(),
      }),
      ...(retrievalV2Admission === undefined ? {} : { retrievalV2Admission }),
    }),
  );
  const generator = createGroundedAnswerGenerator({ config: input.config, runtimeTransport: input.runtimeTransport,
    timeoutMs: meetingKnowledgeProviderLeasePolicy.groundedAnswerTimeoutMilliseconds,
  });
  const selector = createFocusedEvidenceSelector({
    launcherSha256: input.config.subscriptionRuntime.launcherSha256,
    logger: input.logger, runtimeTransport: input.runtimeTransport,
    timeoutMs: meetingKnowledgeProviderLeasePolicy.focusedEvidenceSelectorTimeoutMilliseconds,
  });
  const processor = new ProcessFinalReplyJob({
    answerPublication: publication,
    ...(input.answers === undefined ? {} : { answers: input.answers }),
    authorization,
    evidence,
    ...(input.historicalMemory === undefined ||
      historicalAuthorization === undefined
      ? {}
      : {
          exhaustiveMemory: new HistoricalExhaustiveMemoryRetrieval(
            input.historicalMemory.createExhaustiveCoverage(
              historicalAuthorization,
            ),
            { hash: canonicalFinalReplyTurnHash },
            () => input.historicalMemory?.servingAuthorized() === true,
          ),
        }),
    generator,
    jobs,
    memory,
    selector,
    policy: localFinalReplyPolicy,
    renderer: new DiscordGroundedAnswerRenderer(),
    workerId: `local-final-reply-e${localFinalReplyPolicyRelease.policyEpoch}-${process.pid}`,
  });
  const handler = new DiscordLocalFinalReplyHandler({
    admission,
    admissions,
    client: input.client,
    jobs,
    options: discordQuestionIngressOptions(input.config),
    principals,
    publication,
    reportError,
    scopes: new ConfiguredDiscordQuestionScope(input.sourceConfigurations),
  });
  return createMeetingKnowledgePollingRuntime({
    handler,
    maintenance,
    processor,
    publication,
    reportDuplicateContainment,
    reportError,
  });
}
