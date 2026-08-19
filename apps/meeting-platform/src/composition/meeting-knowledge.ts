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
  ProcessFinalReplyJob,
  SameRoomFocusedMemoryRetrieval,
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
import {
  SubscriptionRuntimeGroundedAnswerAdapter,
  subscriptionRuntimeCliEngine,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";
import type { Client } from "discord.js";
import type { Pool } from "pg";

import type { PlatformConfig } from "../config.js";
import { classifyPlatformError } from "./observability.js";
import type { PlatformHistoricalMemoryRuntime } from "./historical-memory.js";

const processIntervalMilliseconds = 500;
const reconciliationIntervalMilliseconds = 30_000;
const maximumMaintenanceJobsPerPass = 100;
const shutdownDrainTimeoutMilliseconds = 5_000;

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
  // Longer than the grounded-answer adapter's maximum allowed 300-second provider deadline.
  // Reservation renews this lease immediately before the provider call.
  jobLeaseSeconds: 360,
  maximumProviderAttempts: 2,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
  retrieval: Object.freeze({
    maximumCandidates: 24,
    neighborTurns: 2,
  }),
});

export const localFinalReplyPolicyRelease = Object.freeze({
  authorizationPolicyVersion: localFinalReplyPolicy.authorizationPolicyVersion,
  policyEpoch: 1,
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

export interface MeetingKnowledgeLocalFinalReplyRuntime {
  close(): Promise<void>;
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
  /** Deterministic transport fake for production-composition qualification. */
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
  const servingEnabled =
    input.config.meetingKnowledge?.localFinalReply === true;
  const jobs = new PostgresQuestionJobStore(input.pool, localFinalReplyPolicyRelease);
  const publication = new DurableAnswerPublication({
    delivery: input.answerDelivery ?? new DiscordAnswerDeliveryAdapter(
      createDiscordOneAttemptAnswerRest(input.config.secrets.discordToken),
      input.config.discordApplicationId,
    ),
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
  const memory = input.historicalMemory === undefined ||
      historicalAuthorization === undefined
    ? currentMemory
    : new SameRoomFocusedMemoryRetrieval({
        current: currentMemory,
        historical: input.historicalMemory.createFocusedRetrieval(
          historicalAuthorization,
        ),
        turnHashes: { hash: canonicalFinalReplyTurnHash },
      }, {
        historicalServingAuthorized: () =>
          input.historicalMemory?.servingAuthorized() === true,
        remoteSearchAvailable: () =>
          input.historicalMemory?.searchEnabled() === true,
      });
  const admission = new AdmitCurrentFinalReply(
    evidence,
    authorization,
    admissions,
    localFinalReplyPolicy,
  );
  const generator = new SubscriptionRuntimeGroundedAnswerAdapter(
    input.runtimeTransport,
    {
      expectedLauncherSha256: input.config.subscriptionRuntime.launcherSha256,
      expectedRuntimeEngine: subscriptionRuntimeCliEngine,
    },
  );
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
  return {
    close: async () => {
      input.handler?.close();
      clearInterval(processTimer);
      clearInterval(reconcileTimer);
      const ingress = input.handler?.settle();
      await awaitBoundedFinalReplyDrain([ingress, processing, reconciling]);
    },
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
