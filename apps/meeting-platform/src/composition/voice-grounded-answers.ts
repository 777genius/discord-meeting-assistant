import {
  DiscordHistoricalAuthorizationAdapter,
  DiscordQuestionPrincipalCodec,
  decodeDiscordQuestionPrincipalKey,
} from "@discord-meeting/discord-adapter";
import {
  AnswerGroundedMeetingQuestion,
  type GroundedMeetingAnswer,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { canonicalFinalReplyTurnHash } from "@discord-meeting/postgres-adapter";
import type { Client } from "discord.js";

import { MeetingKnowledgeGroundedAnswerAcl } from "../adapters/outbound/meeting-knowledge-grounded-answer-acl.js";
import type { PlatformConfig } from "../config.js";
import type { PlatformHistoricalMemoryRuntime } from "./historical-memory.js";
import type { PlatformLiveFinalizedMemoryRuntime } from "./live-finalized-memory.js";

export function createVoiceGroundedAnswers(
  input: {
    readonly config: PlatformConfig;
    readonly groundedAnswerUseCase?: GroundedMeetingAnswer;
    readonly historicalMemory?: PlatformHistoricalMemoryRuntime;
    readonly liveFinalizedMemory?: PlatformLiveFinalizedMemoryRuntime;
  },
  discord: Client,
): MeetingKnowledgeGroundedAnswerAcl | undefined {
  if (
    input.config.conversation === undefined ||
    input.groundedAnswerUseCase === undefined ||
    input.liveFinalizedMemory === undefined
  ) {
    return undefined;
  }
  const secret = input.config.secrets.meetingKnowledgePrincipalKey;
  if (secret === undefined) {
    throw new Error("Grounded voice requires the Meeting Knowledge principal key");
  }
  const principals = new DiscordQuestionPrincipalCodec(
    decodeDiscordQuestionPrincipalKey(secret),
  );
  const authorization = new DiscordHistoricalAuthorizationAdapter(
    discord,
    principals,
  );
  const answers = new AnswerGroundedMeetingQuestion({
    answers: input.groundedAnswerUseCase,
    authorization,
    ...(input.historicalMemory === undefined
      ? {}
      : {
          exhaustive: input.historicalMemory.createExhaustiveCoverage(authorization),
          focusedHistorical: input.historicalMemory.createFocusedRetrieval(authorization),
          historicalSearchEnabled: () => input.historicalMemory?.searchEnabled() === true,
          historicalServingAuthorized: () =>
            input.historicalMemory?.servingAuthorized() === true,
        }),
    ids: {
      digest: (namespace, parts) =>
        principals.observationDigest(namespace, ...parts),
    },
    live: input.liveFinalizedMemory.query,
    turnHashes: { hash: canonicalFinalReplyTurnHash },
  });
  const principalFor = async (
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
          containerId: request.roomId,
          expiresAtMilliseconds: Date.now() + 5 * 60_000,
          scopeId: context.scopeId,
        });
  };
  return new MeetingKnowledgeGroundedAnswerAcl({
    execute: async (request, options) => {
      const authorizationPrincipalRef = await principalFor(request, options.signal);
      if (authorizationPrincipalRef === null) {
        return {
          reason: "live_room_authority_unavailable",
          schemaVersion: 1,
          status: "unavailable",
        };
      }
      return answers.execute({ ...request, authorizationPrincipalRef }, options);
    },
    recheckPlaybackAuthority: async (request, options) => {
      const authorizationPrincipalRef = await principalFor(request, options.signal);
      return authorizationPrincipalRef === null
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
