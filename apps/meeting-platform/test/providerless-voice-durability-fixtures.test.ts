import type {
  ConversationRuntimeEvent,
  ConversationStartRequest,
} from "@discord-meeting/meeting-core/conversation";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ControlledProviderlessConversationRuntime,
  VirtualClock,
} from
  "./providerless-voice-durability-fixtures.js";
import {
  DurableCraigPlaybackTransport,
  readEvents,
} from "./providerless-voice-durability-recording.js";

const cohortCommand = Object.freeze({
  idempotencyKey: "25:proactive-conversation:v1|9:meeting-1|9:meeting-1|9:command-1",
  literalSpeech: "Привет, Тест А! Hi, Test B!",
  locale: "ru",
  meetingId: "meeting-1",
  prompt: "Привет, Тест А! Hi, Test B!",
  recordingId: "meeting-1",
  speakerId: "participant-1",
  systemPrompt: "Speak the literal greeting.",
  turnId: "participant-greeting:participant-1",
  voiceProfileId: "providerless-voice",
} satisfies ConversationStartRequest);

describe("providerless durability conversation runtime", () => {
  it("emits immediate PCM for a clustered literal greeting", async () => {
    const runtime = new ControlledProviderlessConversationRuntime();

    const result = await runtime.startTurn(cohortCommand);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const events = await collect(result.value.events);

    expect(events.map(({ type }) => type)).toEqual([
      "accepted",
      "tts-attestation",
      "audio-start",
      "audio-chunk",
      "audio-chunk",
      "audio-end",
      "completed",
    ]);
    expect(runtime.proactiveRequests).toEqual([cohortCommand]);
    expect(events.filter(({ type }) => type === "audio-chunk")).toHaveLength(2);
    expect(runtime.activeTurns).toBe(0);
  });

  it("uses one provider attempt identity when a pre-start command is retried", async () => {
    const runtime = new ControlledProviderlessConversationRuntime();
    const first = await runtime.startTurn(cohortCommand);
    const retry = await runtime.startTurn({
      ...cohortCommand,
      turnId: "participant-greeting:participant-1:retry-1",
    });
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) {
      return;
    }

    const [firstEvents, retryEvents] = await Promise.all([
      collect(first.value.events),
      collect(retry.value.events),
    ]);
    expect(firstEvents[0]?.attemptId).toBe(retryEvents[0]?.attemptId);
    expect(firstEvents.filter(({ type }) => type === "audio-chunk")).toHaveLength(2);
    expect(retryEvents.filter(({ type }) => type === "audio-chunk")).toHaveLength(2);
  });

  it("replays original start evidence and never accepts duplicate PCM after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "providerless-craig-dedup-"));
    const clock = new VirtualClock(1_000);
    const envelope = {
      attemptId: "attempt-1",
      recordingId: "meeting-1",
      schemaVersion: 1 as const,
      turnId: "turn-1",
    };
    try {
      const first = await DurableCraigPlaybackTransport.open({
        clock,
        meetingId: "meeting-1",
        phase: "first",
        root,
      });
      const firstEvents: Array<{ readonly startedAtMs: number }> = [];
      first.onEvent((event) => {
        if (event.type === "playback-started") {
          firstEvents.push({ startedAtMs: event.startedAtMs });
        }
      });
      await first.send({
        ...envelope,
        channels: 1,
        format: "pcm_s16le",
        sampleRateHz: 48_000,
        type: "playback-start",
      });
      await first.send({
        ...envelope,
        pcmBase64: "AQACAA==",
        sequence: 0,
        type: "audio-chunk",
      });
      expect(firstEvents).toEqual([{ startedAtMs: 1_000 }]);

      await clock.advanceTo(9_000);
      const restarted = await DurableCraigPlaybackTransport.open({
        clock,
        meetingId: "meeting-1",
        phase: "restarted",
        root,
      });
      const replayedEvents: Array<{ readonly startedAtMs: number }> = [];
      restarted.onEvent((event) => {
        if (event.type === "playback-started") {
          replayedEvents.push({ startedAtMs: event.startedAtMs });
        }
      });
      await restarted.send({
        ...envelope,
        channels: 1,
        format: "pcm_s16le",
        sampleRateHz: 48_000,
        type: "playback-start",
      });
      await restarted.send({
        ...envelope,
        pcmBase64: "AQACAA==",
        sequence: 0,
        type: "audio-chunk",
      });

      expect(replayedEvents).toEqual([{ startedAtMs: 1_000 }]);
      expect((await readEvents(root)).filter(({ type }) => type === "audio-chunk"))
        .toHaveLength(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

async function collect(
  events: AsyncIterable<ConversationRuntimeEvent>,
): Promise<readonly ConversationRuntimeEvent[]> {
  const collected: ConversationRuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
