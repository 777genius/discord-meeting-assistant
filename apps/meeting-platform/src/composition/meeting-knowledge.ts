import {
  DiscordAnswerDeliveryAdapter,
  DiscordAnswerPayloadCodec,
  DiscordGroundedAnswerRenderer,
  DiscordHistoricalAuthorizationAdapter,
  DiscordLocalFinalReplyHandler,
  DiscordQuestionAuthorizationAdapter,
  DiscordQuestionPrincipalCodec,
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
import {
  DurableAnswerPublication,
  type AnswerDeliveryPort,
} from "@discord-meeting/meeting-core/publishing";
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
import type { Pool } from "pg";
import { TestOnlyAnswerDeliveryCrashInjection } from
  "../adapters/outbound/test-only-answer-delivery-crash-injection.js";

import type { PlatformConfig } from "../config.js";
import { classifyPlatformError } from "./observability.js";
import type { PlatformHistoricalMemoryRuntime } from "./historical-memory.js";
import { createPersistedFocusedMemoryRoute } from
  "./meeting-knowledge-retrieval-router.js";
import { createFocusedEvidenceSelector, createGroundedAnswerGenerator } from
  "./meeting-knowledge-provider-composition.js";

const processIntervalMilliseconds = 500;
const reconciliationIntervalMilliseconds = 30_000;
const maximumMaintenanceJobsPerPass = 100;
const shutdownDrainTimeoutMilliseconds = 5_000;
const meetingKnowledgeProviderLeasePolicy = Object.freeze({
  focusedEvidenceSelectorTimeoutMilliseconds: 60_000,
  groundedAnswerTimeoutMilliseconds: 180_000,
  maximumGroundedAnswerExecutions: 2, safetyMilliseconds: 120_000,
});
const providerAttemptLeaseSeconds = (
  meetingKnowledgeProviderLeasePolicy.focusedEvidenceSelectorTimeoutMilliseconds +
  (meetingKnowledgeProviderLeasePolicy.maximumGroundedAnswerExecutions *
    meetingKnowledgeProviderLeasePolicy.groundedAnswerTimeoutMilliseconds) +
  meetingKnowledgeProviderLeasePolicy.safetyMilliseconds
) / 1_000;

export class MeetingKnowledgeDrainTimeoutError extends Error {
  public constructor(timeoutMilliseconds: number) {
    super(
      `Meeting Knowledge final reply drain exceeded ${timeoutMilliseconds}ms`,
    );
    this.name = "MeetingKnowledgeDrainTimeoutError";
  }
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
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v3",
  retrieval: Object.freeze({ maximumCandidates: qualifiedFocusedEvidenceCandidateLimit, neighborTurns: 2 }),
  retrievalAdmission: Object.freeze({
    cutoverEpoch: "infinity-locator-v2-only-r1",
    infinityProfileFingerprint: "2e69df6bf22461ee8d6844c7e6699cfb099ad36d84b0aa15f1d3061754ff27be",
  }),
});

const localFinalReplyPolicyRelease = Object.freeze({
  authorizationPolicyVersion: localFinalReplyPolicy.authorizationPolicyVersion, policyEpoch: 3,
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

export interface MeetingKnowledgeLocalFinalReplyRuntime {
  close(): Promise<void>;
  processPending(): Promise<void>; reconcilePending(): Promise<void>;
  settleIngress(): Promise<void>;
  start(): void;
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
  const servingEnabled = input.config.meetingKnowledge?.localFinalReply === true;
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
  const admission = new AdmitCurrentFinalReply(
    evidence,
    authorization,
    admissions,
    Object.freeze({
      ...localFinalReplyPolicy,
      retrievalAdmission: Object.freeze({
        ...localFinalReplyPolicy.retrievalAdmission,
        ...(input.config.meetingKnowledge.retrievalV2ProviderBinding === undefined
          ? {}
          : { retrievalV2ProviderBinding:
              input.config.meetingKnowledge.retrievalV2ProviderBinding }),
      }),
    }),
    createRetrievalV2Admission(input.historicalMemory, input.config),
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

async function awaitBoundedFinalReplyDrain(
  operations: readonly (Promise<unknown> | undefined)[],
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const pending = operations.filter(
    (operation): operation is Promise<unknown> => operation !== undefined);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new MeetingKnowledgeDrainTimeoutError(
        shutdownDrainTimeoutMilliseconds,
      ));
    }, shutdownDrainTimeoutMilliseconds);
    timer.unref();
  });
  try {
    const results = await Promise.race([
      Promise.allSettled(pending),
      timeout,
    ]);
    const failures = results.flatMap((result): unknown[] =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Meeting Knowledge drain failed");
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function createMeetingKnowledgePollingRuntime(input: {
  readonly handler?: Pick<
    DiscordLocalFinalReplyHandler,
    "close" | "settle" | "start"
  >;
  readonly maintenance: MaintainFinalReplies;
  readonly processor?: Pick<ProcessFinalReplyJob, "executeOnce">;
  readonly publication: Pick<
    DurableAnswerPublication,
    "reconcileRetractions" | "reconcileUnknown"
  >;
  readonly reportDuplicateContainment?: (count: number) => void;
  readonly reportError: (error: unknown) => void;
}): MeetingKnowledgeLocalFinalReplyRuntime {
  let processing: Promise<unknown> | undefined;
  let reconciling: Promise<unknown> | undefined;
  let processTimer: NodeJS.Timeout | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  const processOnce = (): void => {
    processing ??= input.maintenance.execute(maximumMaintenanceJobsPerPass)
      .then(async () => await input.processor?.executeOnce())
      .catch(input.reportError)
      .finally(() => {
        processing = undefined;
      });
  };
  const reconcile = (): void => {
    reconciling ??= input.publication.reconcileUnknown(100)
      .then((result) => {
        if (result.containedDuplicates > 0) {
          input.reportDuplicateContainment?.(result.containedDuplicates);
        }
        return result;
      })
      .then(async () => await input.publication.reconcileRetractions(100))
      .catch(input.reportError)
      .finally(() => {
        reconciling = undefined;
      });
  };
  const processPending = async (): Promise<void> => {
    await processing;
    processOnce();
    await processing;
  };
  const reconcilePending = async (): Promise<void> => {
    await reconciling;
    reconcile();
    await reconciling;
  };
  return {
    close: async () => {
      input.handler?.close();
      clearInterval(processTimer);
      clearInterval(reconcileTimer);
      const ingress = input.handler?.settle();
      await awaitBoundedFinalReplyDrain([ingress, processing, reconciling]);
    },
    processPending,
    reconcilePending,
    settleIngress: () => input.handler?.settle() ?? Promise.resolve(),
    start: () => {
      if (processTimer !== undefined) {
        return;
      }
      input.handler?.start();
      processTimer = setInterval(processOnce, processIntervalMilliseconds);
      reconcileTimer = setInterval(reconcile, reconciliationIntervalMilliseconds);
      processTimer.unref();
      reconcileTimer.unref();
      processOnce();
      reconcile();
    },
  };
}
