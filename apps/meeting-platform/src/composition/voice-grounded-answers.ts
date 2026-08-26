import {
  DiscordHistoricalAuthorizationAdapter,
  DiscordQuestionPrincipalCodec,
  decodeDiscordQuestionPrincipalKey,
} from "@discord-meeting/discord-adapter";
import {
  AnswerGroundedMeetingQuestion,
  FocusedHistoricalEvidenceV2,
  type HistoricalAuthorizationPort,
  type GroundedMeetingAnswer,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { canonicalFinalReplyTurnHash } from "@discord-meeting/postgres-adapter";
import type { Client } from "discord.js";
import { readFile } from "node:fs/promises";

import { MeetingKnowledgeGroundedAnswerAcl } from "../adapters/outbound/meeting-knowledge-grounded-answer-acl.js";
import type { PlatformConfig } from "../config.js";
import type { PlatformHistoricalMemoryRuntime } from "./historical-memory.js";
import type { PlatformLiveFinalizedMemoryRuntime } from "./live-finalized-memory.js";

export interface VoiceGroundedAnswersAuthoritySeams {
  readonly historicalAuthorization: HistoricalAuthorizationPort;
  readonly principalFor: (
    request: {
      readonly activeParticipantId: string;
      readonly meetingId: string;
      readonly roomId: string;
    },
    signal: AbortSignal,
  ) => Promise<string | null>;
  readonly rolloutAuthorized: (signal: AbortSignal) => Promise<boolean>;
}

export function createGroundedVoiceRolloutAuthority(
  rolloutStateFile: string,
  rolloutEpoch: string,
): (signal: AbortSignal) => Promise<boolean> {
  return async (signal) => {
    signal.throwIfAborted();
    try {
      const raw = await readFile(rolloutStateFile, { encoding: "utf8", signal });
      signal.throwIfAborted();
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).toSorted().join(",") === "enabled,rolloutEpoch" &&
        "enabled" in parsed && parsed.enabled === true &&
        "rolloutEpoch" in parsed && parsed.rolloutEpoch === rolloutEpoch;
    } catch {
      signal.throwIfAborted();
      return false;
    }
  };
}

export function createVoiceGroundedAnswers(
  input: {
    readonly config: PlatformConfig;
    readonly authority?: VoiceGroundedAnswersAuthoritySeams;
    readonly groundedAnswerUseCase?: GroundedMeetingAnswer;
    readonly historicalMemory?: PlatformHistoricalMemoryRuntime;
    readonly liveFinalizedMemory?: Pick<PlatformLiveFinalizedMemoryRuntime, "query">;
  },
  discord: Client,
): MeetingKnowledgeGroundedAnswerAcl | undefined {
  if (
    input.config.conversation === undefined ||
    input.config.meetingKnowledge?.groundedVoice === undefined ||
    input.groundedAnswerUseCase === undefined ||
    input.liveFinalizedMemory === undefined
  ) {
    return undefined;
  }
  const rolloutEpoch = input.config.meetingKnowledge.groundedVoice.rolloutEpoch;
  const rolloutStateFile = input.config.meetingKnowledge.groundedVoice.rolloutStateFile;
  const rolloutAuthorized = input.authority?.rolloutAuthorized ??
    createGroundedVoiceRolloutAuthority(rolloutStateFile, rolloutEpoch);
  const secret = input.config.secrets.meetingKnowledgePrincipalKey;
  if (secret === undefined) {
    throw new Error("Grounded voice requires the Meeting Knowledge principal key");
  }
  const principals = new DiscordQuestionPrincipalCodec(
    decodeDiscordQuestionPrincipalKey(secret),
  );
  const authorization = input.authority?.historicalAuthorization ??
    new DiscordHistoricalAuthorizationAdapter(discord, principals);
  const answers = new AnswerGroundedMeetingQuestion({
    answers: input.groundedAnswerUseCase,
    authorization,
    ...(input.historicalMemory === undefined ? {} : {
      exhaustive: input.historicalMemory.createExhaustiveCoverage(authorization),
    }),
    ...(input.historicalMemory === undefined ||
      input.config.meetingKnowledge.retrievalV2ProviderBinding === undefined
      ? {}
      : {
          historical: new FocusedHistoricalEvidenceV2({
            admission: input.historicalMemory.createRetrievalV2Admission(
              input.config.meetingKnowledge.retrievalV2ProviderBinding,
            ),
            retrieval: input.historicalMemory.createFocusedLocatorRetrievalV2(
              authorization,
            ),
          }),
        }),
    ids: {
      digest: (namespace, parts) =>
        principals.observationDigest(namespace, ...parts),
    },
    live: input.liveFinalizedMemory.query,
    turnHashes: { hash: canonicalFinalReplyTurnHash },
  });
  const productionPrincipalFor = async (
    request: {
      readonly activeParticipantId: string;
      readonly meetingId: string;
      readonly roomId: string;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    signal.throwIfAborted();
    const context = await input.liveFinalizedMemory?.query.resolveContext({
      meetingId: request.meetingId,
      requesterActorId: request.activeParticipantId,
      roomId: request.roomId,
      signal,
    });
    signal.throwIfAborted();
    return context === null || context === undefined
      ? null
      : principals.issue({
          actorId: request.activeParticipantId,
          authorizationContainerId: request.roomId,
          containerId: request.roomId,
          expiresAtMilliseconds: Date.now() + 5 * 60_000,
          scopeId: context.scopeId,
        });
  };
  const principalFor = input.authority?.principalFor ?? productionPrincipalFor;
  return new MeetingKnowledgeGroundedAnswerAcl({
    execute: async (request, options) => {
      options.signal.throwIfAborted();
      if (!await rolloutAuthorized(options.signal)) {
        return {
          reason: "grounded_voice_rollout_disabled",
          schemaVersion: 1,
          status: "unavailable",
        };
      }
      const authorizationPrincipalRef = await principalFor(request, options.signal);
      if (!await rolloutAuthorized(options.signal) || authorizationPrincipalRef === null) {
        return {
          reason: "live_room_authority_unavailable",
          schemaVersion: 1,
          status: "unavailable",
        };
      }
      return answers.execute({ ...request, authorizationPrincipalRef }, options);
    },
    recheckPlaybackAuthority: async (request, options) => {
      options.signal.throwIfAborted();
      if (!await rolloutAuthorized(options.signal)) {
        return {
          reason: "grounded_voice_rollout_disabled",
          schemaVersion: 1,
          status: "stale",
        };
      }
      const authorizationPrincipalRef = await principalFor(request, options.signal);
      return !await rolloutAuthorized(options.signal) || authorizationPrincipalRef === null
        ? {
            reason: "live_room_authority_unavailable",
            schemaVersion: 1,
            status: "stale",
          }
        : answers.recheckPlaybackAuthority(
            { ...request, authorizationPrincipalRef },
            options,
          );
    },
  });
}
