import type {
  ConversationAudioChunk,
  ConversationCancellationReason,
  ConversationPortResult,
  ConversationRuntime,
  ConversationRuntimeEvent,
  ConversationRuntimeTurn,
  ConversationStartRequest,
  VoicePlaybackEvent,
  VoicePlaybackPort,
  VoicePlaybackRequest,
  VoicePlaybackSession,
} from "@discord-meeting/meeting-core/conversation";
import { ConversationCoordinator } from "@discord-meeting/meeting-core/conversation";
import { describe, expect, it, vi } from "vitest";

import {
  MeetingKnowledgeGroundedAnswerAcl,
  type PublishedMeetingKnowledgeAnswerUseCase,
} from "../src/adapters/outbound/meeting-knowledge-grounded-answer-acl.js";

describe("provider-neutral grounded knowledge conversation E2E", () => {
  it("uses a deterministic published fake, validates it, then speaks only literal text", async () => {
    const execute = vi.fn<PublishedMeetingKnowledgeAnswerUseCase["execute"]>(async () => ({
      answer: {
        citations: [{ turnId: "authoritative-turn-7" }],
        evidenceEpoch: "evidence-7",
        knowledgeEpoch: "knowledge-9",
        plainText: "Решили выпустить в пятницу.",
      },
      schemaVersion: 1,
      status: "answered",
    }));
    const recheckPlaybackAuthority = vi.fn<
      PublishedMeetingKnowledgeAnswerUseCase["recheckPlaybackAuthority"]
    >(async () => ({ schemaVersion: 1, status: "current" }));
    const runtime = new LiteralRuntime();
    const playback = new CapturingPlayback();
    const coordinator = new ConversationCoordinator({
      groundedAnswers: new MeetingKnowledgeGroundedAnswerAcl({
        execute,
        recheckPlaybackAuthority,
      }),
      playback,
      runtime,
    });

    await coordinator.handleFinalizedTurn({
      locale: "ru-RU",
      meetingId: "meeting-1",
      nowMs: 1,
      recordingId: "recording-1",
      roomId: "private-room-1",
      speakerId: "test-participant-1",
      systemPrompt: "Отвечай только по авторитетной расшифровке.",
      text: "Ботик, что решили?",
      thinkingCueLocale: "ru-RU",
      transcriptEndMs: 1_000,
      transcriptStartMs: 500,
      turnId: "question-turn-1",
      voiceProfileId: "test-voice",
    });
    await coordinator.whenIdle("meeting-1");

    const options = execute.mock.calls[0]?.[1];
    expect(options?.signal.aborted).toBe(false);
    expect(execute).toHaveBeenCalledWith({
      activeParticipantId: "test-participant-1",
      locale: "ru-RU",
      meetingId: "meeting-1",
      question: "что решили?",
      roomId: "private-room-1",
    }, { signal: options?.signal });
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]).toMatchObject({
      literalSpeech: "Решили выпустить в пятницу.",
      prompt: "что решили?",
    });
    expect(playback.chunks).toEqual([Uint8Array.of(7, 9)]);
    expect(recheckPlaybackAuthority).toHaveBeenCalledOnce();
  });
});

class LiteralRuntime implements ConversationRuntime {
  public readonly requests: ConversationStartRequest[] = [];

  public startTurn(
    request: ConversationStartRequest,
  ): Promise<ConversationPortResult<ConversationRuntimeTurn>> {
    this.requests.push(structuredClone(request));
    if (request.literalSpeech === undefined) {
      throw new Error("the grounded E2E must use literal speech");
    }
    const events = stream<ConversationRuntimeEvent>([
      { attemptId: "literal-attempt-1", type: "accepted" },
      {
        attemptId: "literal-attempt-1",
        channels: 1,
        format: "pcm_s16le",
        sampleRateHz: 48_000,
        type: "audio-start",
      },
      {
        attemptId: "literal-attempt-1",
        bytes: Uint8Array.of(7, 9),
        channels: 1,
        format: "pcm_s16le",
        sampleRateHz: 48_000,
        sequence: 0,
        turnId: request.turnId,
        type: "audio-chunk",
      },
      { attemptId: "literal-attempt-1", type: "audio-end" },
      { attemptId: "literal-attempt-1", type: "completed" },
    ]);
    return Promise.resolve({
      ok: true,
      value: { cancel: () => Promise.resolve(), events },
    });
  }
}

class CapturingPlayback implements VoicePlaybackPort {
  public readonly chunks: Uint8Array[] = [];

  public open(
    request: VoicePlaybackRequest,
  ): Promise<ConversationPortResult<VoicePlaybackSession>> {
    const events = new PushStream<VoicePlaybackEvent>();
    events.push({ attemptId: request.attemptId, startedAtMs: 2, type: "started" });
    return Promise.resolve({
      ok: true,
      value: {
        cancel: (_reason: ConversationCancellationReason) => {
          events.push({ attemptId: request.attemptId, finishedAtMs: 3, type: "finished" });
          events.close();
          return Promise.resolve({ ok: true, value: "cancelled" as const });
        },
        events,
        finish: () => {
          events.push({ attemptId: request.attemptId, finishedAtMs: 3, type: "finished" });
          events.close();
          return Promise.resolve({ ok: true, value: "finished" as const });
        },
        write: (chunk: ConversationAudioChunk) => {
          this.chunks.push(Uint8Array.from(chunk.bytes));
          return Promise.resolve({ ok: true, value: "accepted" as const });
        },
      },
    });
  }
}

class PushStream<Value> implements AsyncIterable<Value> {
  private closed = false;
  private readonly queued: Value[] = [];
  private waiter: ((result: IteratorResult<Value>) => void) | null = null;

  public close(): void {
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = null;
  }

  public push(value: Value): void {
    if (this.waiter === null) {
      this.queued.push(value);
      return;
    }
    this.waiter({ done: false, value });
    this.waiter = null;
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<Value> {
    for (;;) {
      const next = await this.next();
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  }

  private next(): Promise<IteratorResult<Value>> {
    const value = this.queued.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

function stream<Value>(values: readonly Value[]): AsyncIterable<Value> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Value> {
      yield* values;
    },
  };
}
