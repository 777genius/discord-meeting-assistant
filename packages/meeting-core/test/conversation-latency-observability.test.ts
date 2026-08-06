import { describe, expect, it } from "vitest";

import { ConversationCoordinator } from "../src/application/conversation.js";
import type { ConversationLatencyObservation } from "../src/application/ports.js";
import {
  RecordingPlayback,
  ScriptedRuntime,
  closedStream,
  input,
} from "./conversation-coordinator-fixture.js";

describe("ConversationCoordinator latency telemetry", () => {
  it("publishes a valid provider-neutral observation for the active attempt", async () => {
    const observations: ConversationLatencyObservation[] = [];
    const runtime = new ScriptedRuntime([
      closedStream([
        { attemptId: "attempt-1", type: "accepted" },
        {
          attemptId: "attempt-1",
          endTurnToWakeMs: 250,
          firstLlmTokenToAudioMs: 120,
          totalToFirstAudioMs: 1_870,
          type: "latency",
          wakeToFirstLlmTokenMs: 1_500,
        },
        { attemptId: "attempt-1", type: "completed" },
      ]),
    ]);
    const coordinator = new ConversationCoordinator({
      latencyObserver: {
        observeConversationLatency: (observation) => {
          observations.push(observation);
        },
      },
      playback: new RecordingPlayback(),
      runtime,
    });

    await coordinator.handleFinalizedTurn(
      input("turn-1", 0, "Ботик, ответь кратко.", { speakerId: "speaker-1" }),
    );
    await coordinator.whenIdle("meeting-1");

    expect(observations).toEqual([
      {
        attemptId: "attempt-1",
        endTurnToWakeMs: 250,
        firstLlmTokenToAudioMs: 120,
        meetingId: "meeting-1",
        totalToFirstAudioMs: 1_870,
        turnId: "turn-1",
        wakeToFirstLlmTokenMs: 1_500,
      },
    ]);
  });

  it("isolates an observability sink failure from conversation completion", async () => {
    const runtime = new ScriptedRuntime([
      closedStream([
        { attemptId: "attempt-1", type: "accepted" },
        {
          attemptId: "attempt-1",
          endTurnToWakeMs: 10,
          firstLlmTokenToAudioMs: 30,
          totalToFirstAudioMs: 60,
          type: "latency",
          wakeToFirstLlmTokenMs: 20,
        },
        { attemptId: "attempt-1", type: "completed" },
      ]),
    ]);
    const coordinator = new ConversationCoordinator({
      latencyObserver: {
        observeConversationLatency: () => {
          throw new Error("metrics sink unavailable");
        },
      },
      playback: new RecordingPlayback(),
      runtime,
    });

    await expect(
      coordinator.handleFinalizedTurn(input("turn-1", 0)),
    ).resolves.toMatchObject({ status: "active" });
    await expect(coordinator.whenIdle("meeting-1")).resolves.toBeUndefined();
  });

  it("isolates an asynchronous observability rejection from conversation completion", async () => {
    const runtime = new ScriptedRuntime([
      closedStream([
        { attemptId: "attempt-1", type: "accepted" },
        {
          attemptId: "attempt-1",
          endTurnToWakeMs: 10,
          firstLlmTokenToAudioMs: 30,
          totalToFirstAudioMs: 60,
          type: "latency",
          wakeToFirstLlmTokenMs: 20,
        },
        { attemptId: "attempt-1", type: "completed" },
      ]),
    ]);
    const coordinator = new ConversationCoordinator({
      latencyObserver: {
        observeConversationLatency: () =>
          Promise.reject(new Error("async metrics sink unavailable")),
      },
      playback: new RecordingPlayback(),
      runtime,
    });

    await expect(
      coordinator.handleFinalizedTurn(input("turn-1", 0)),
    ).resolves.toMatchObject({ status: "active" });
    await expect(coordinator.whenIdle("meeting-1")).resolves.toBeUndefined();
    await Promise.resolve();
  });
});
