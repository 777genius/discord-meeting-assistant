import type { CraigPlaybackCommand } from "@discord-meeting/craig-gateway-contracts";
import {
  ConversationCoordinator,
  type ConversationRuntime,
  type GroundedKnowledgeAnswerOptions,
  type GroundedKnowledgeAnswerRequest,
  type VoicePlaybackPort,
} from "@discord-meeting/meeting-core/conversation";
import {
  AnswerGroundedMeetingQuestion,
  GroundedMeetingAnswer,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { expect } from "vitest";

interface PlaybackHarness {
  readonly commands: CraigPlaybackCommand[];
  close(): Promise<void>;
  readonly playback: VoicePlaybackPort;
}

export async function proveGroundedConversationTransport(input: {
  openPlaybackHarness(recordingId: string): Promise<PlaybackHarness>;
  readonly runtime: ConversationRuntime;
  readonly voiceProfileId: string;
  waitForCondition(condition: () => boolean): Promise<void>;
}): Promise<void> {
  const recordingId = "recording-grounded-e2e";
  const meetingId = "meeting-grounded-e2e";
  const turnId = "grounded-question-e2e";
  const harness = await input.openPlaybackHarness(recordingId);
  const calls: Array<{
    readonly options: GroundedKnowledgeAnswerOptions;
    readonly request: GroundedKnowledgeAnswerRequest;
  }> = [];
  const liveContext = {
    appliedGeneration: 1,
    humanActorIds: ["synthetic-participant-grounded-e2e"],
    identityGeneration: 1,
    knowledgeEpoch: "live-memory:v1:providerless-grounded-e2e",
    meetingId,
    roomId: "private-room-grounded-e2e",
    scopeId: "private-scope-grounded-e2e",
    sourceGeneration: 1,
  } as const;
  const sharedAnswer = new AnswerGroundedMeetingQuestion({
    answers: new GroundedMeetingAnswer({
      measure: async () => ({
        inputTokens: 64,
        requestBytes: 512,
        runtimeProfile: "providerless-shared-answer.v1",
      }),
      generate: async () => ({
        answer: {
          claims: [{
            evidenceIds: ["evidence-000001"],
            text: "Решили выпустить в пятницу.",
          }],
          locale: "ru",
          status: "answered",
        },
        status: "completed",
      }),
    }, {
      maximumRequestBytes: 8_192,
      modelContextTokens: 4_096,
      outputTokensReserved: 256,
      reasoningTokensReserved: 256,
      safeInputTokens: 3_000,
      tokenDriftReserve: 128,
    }),
    ids: { digest: () => "c".repeat(64) },
    live: {
      resolveContext: async (request) =>
        request.meetingId === meetingId &&
          request.roomId === liveContext.roomId &&
          request.requesterActorId === liveContext.humanActorIds[0]
          ? liveContext
          : null,
      searchHotTail: async () => ({
        candidates: [{
          meetingId,
          sourceGeneration: 1,
          turnHash: "b".repeat(64),
          turnId: "authoritative-turn-7",
        }],
        context: liveContext,
        schemaVersion: 1,
        status: "current",
      }),
      rehydrateHotTail: async () => ({
        context: liveContext,
        schemaVersion: 1,
        status: "current",
        turns: [{
          endMs: 7_000,
          speakerId: "synthetic-participant-grounded-e2e",
          startMs: 6_000,
          text: "Решили выпустить в пятницу.",
          turnHash: "b".repeat(64),
          turnId: "authoritative-turn-7",
        }],
      }),
    },
    turnHashes: { hash: () => "b".repeat(64) },
  });
  const coordinator = new ConversationCoordinator({
    groundedAnswers: {
      answer: async (groundedRequest, options) => {
        calls.push({ options, request: structuredClone(groundedRequest) });
        const result = await sharedAnswer.execute({
          activeParticipantId: groundedRequest.participantId,
          locale: groundedRequest.locale,
          meetingId: groundedRequest.meetingId,
          question: groundedRequest.question,
          roomId: groundedRequest.roomId,
        }, options);
        return result.status === "answered"
          ? {
              ok: true as const,
              value: {
                ...result.answer,
                schemaVersion: 1 as const,
                status: "answered" as const,
              },
            }
          : {
              failure: {
                code: "SHARED_GROUNDED_ANSWER_UNAVAILABLE",
                message: result.reason,
                retryable: result.status === "unavailable",
              },
              ok: false as const,
            };
      },
      recheckPlaybackAuthority: async (authority, options) => {
        const result = await sharedAnswer.recheckPlaybackAuthority({
          activeParticipantId: authority.request.participantId,
          citationTurnIds: authority.citationTurnIds,
          evidenceEpoch: authority.evidenceEpoch,
          knowledgeEpoch: authority.knowledgeEpoch,
          locale: authority.request.locale,
          meetingId: authority.request.meetingId,
          question: authority.request.question,
          roomId: authority.request.roomId,
        }, options);
        return result.status === "current"
          ? { ok: true as const, value: "current" as const }
          : {
              failure: {
                code: "SHARED_GROUNDED_PLAYBACK_STALE",
                message: result.reason,
                retryable: false,
              },
              ok: false as const,
            };
      },
    },
    playback: harness.playback,
    runtime: input.runtime,
  });

  try {
    await expect(coordinator.handleFinalizedTurn({
      locale: "ru-RU",
      meetingId,
      nowMs: 1,
      recordingId,
      roomId: "private-room-grounded-e2e",
      speakerId: "synthetic-participant-grounded-e2e",
      systemPrompt: "Answer only from authoritative transcript evidence.",
      text: "Ботик, что решили?",
      thinkingCueLocale: "ru-RU",
      transcriptEndMs: 1_000,
      transcriptStartMs: 500,
      turnId,
      voiceProfileId: input.voiceProfileId,
    })).resolves.toMatchObject({ prompt: "что решили?", status: "active" });
    await coordinator.whenIdle(meetingId);
    await expect(coordinator.whenTurnPlaybackSettled(meetingId, turnId))
      .resolves.toBe("played");
    await input.waitForCondition(() =>
      harness.commands.some((command) => command.type === "playback-finish"),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toEqual({
      locale: "ru-RU",
      meetingId,
      participantId: "synthetic-participant-grounded-e2e",
      question: "что решили?",
      roomId: "private-room-grounded-e2e",
    });
    expect(calls[0]?.options.signal.aborted).toBe(false);
    expect(harness.commands[0]).toMatchObject({ recordingId, turnId, type: "playback-start" });
    const audioCommands = harness.commands.filter(
      (command): command is Extract<CraigPlaybackCommand, { type: "audio-chunk" }> =>
        command.type === "audio-chunk",
    );
    expect(audioCommands.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(audioCommands.every(({ pcmBase64 }) => pcmBase64.length > 0)).toBe(true);
    expect(harness.commands.at(-1)).toMatchObject({ recordingId, turnId, type: "playback-finish" });
    await coordinator.closeMeeting(meetingId, Math.floor(performance.now()));
  } finally {
    await harness.close();
  }
}
