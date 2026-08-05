import { describe, expect, it, vi } from "vitest";

import { ConversationCoordinator } from "../src/application/conversation.js";
import type { ConversationRuntimeEvent } from "../src/application/ports.js";
import {
  CloseWithoutFinishedPlayback,
  EventStream,
  FailingCancellationPlayback,
  HeldFirstTerminalPlayback,
  HeldTerminalPlaybackSession,
  ScriptedRuntime,
  closedStream,
  input,
} from "./conversation-coordinator-fixture.js";

describe("ConversationCoordinator playback terminal fencing", () => {
  it("keeps meeting close pending until active playback has a terminal receipt", async () => {
    const stream = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([stream]);
    const playback = new HeldFirstTerminalPlayback();
    const coordinator = new ConversationCoordinator({ playback, runtime });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    stream.push({ attemptId: "attempt-1", type: "accepted" });
    stream.push({
      attemptId: "attempt-1",
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      type: "audio-start",
    });
    await vi.waitFor(() => {
      expect(playback.sessions).toHaveLength(1);
    });

    let closed = false;
    const closing = coordinator.closeMeeting("meeting-1", 101).then(() => {
      closed = true;
      return null;
    });
    await vi.waitFor(() => {
      expect(playback.sessions[0]?.cancelReasons).toEqual(["meeting-ended"]);
    });
    expect(closed).toBe(false);

    const session = playback.sessions[0];
    if (!(session instanceof HeldTerminalPlaybackSession)) {
      throw new Error("expected terminal-held playback");
    }
    session.complete(200);
    await closing;
    expect(closed).toBe(true);
  });

  it("waits for the prior answer terminal receipt before starting a queued successor", async () => {
    const first = new EventStream<ConversationRuntimeEvent>();
    const second = closedStream([
      { attemptId: "attempt-2", type: "accepted" },
      { attemptId: "attempt-2", type: "completed" },
    ]);
    const runtime = new ScriptedRuntime([first, second]);
    const playback = new HeldFirstTerminalPlayback();
    const coordinator = new ConversationCoordinator({ playback, runtime });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    await coordinator.handleFinalizedTurn(input("turn-2", 1));
    first.push({ attemptId: "attempt-1", type: "accepted" });
    first.push({
      attemptId: "attempt-1",
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      type: "audio-start",
    });
    await vi.waitFor(() => {
      expect(playback.sessions).toHaveLength(1);
    });

    first.push({ attemptId: "attempt-1", reason: "superseded", type: "cancelled" });
    await vi.waitFor(() => {
      expect(playback.sessions[0]?.cancelReasons).toEqual(["superseded"]);
    });
    expect(runtime.requests.map((request) => request.turnId)).toEqual(["turn-1"]);

    const firstPlayback = playback.sessions[0];
    if (!(firstPlayback instanceof HeldTerminalPlaybackSession)) {
      throw new Error("expected terminal-held playback");
    }
    firstPlayback.complete(200);
    await vi.waitFor(() => {
      expect(runtime.requests.map((request) => request.turnId)).toEqual(["turn-1", "turn-2"]);
    });
    first.close();
    await coordinator.whenIdle("meeting-1");
  });

  it("does not treat a closed playback stream without finished as a successful stop", async () => {
    const first = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([
      first,
      closedStream([
        { attemptId: "attempt-2", type: "accepted" },
        { attemptId: "attempt-2", type: "completed" },
      ]),
    ]);
    const playback = new CloseWithoutFinishedPlayback();
    const coordinator = new ConversationCoordinator({ playback, runtime });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    await coordinator.handleFinalizedTurn(input("turn-2", 1));
    first.push({ attemptId: "attempt-1", type: "accepted" });
    first.push({
      attemptId: "attempt-1",
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      type: "audio-start",
    });
    first.push({ attemptId: "attempt-1", type: "audio-end" });
    await vi.waitFor(() => {
      expect(playback.sessions[0]?.finishCalls).toBe(1);
    });
    first.push({ attemptId: "attempt-1", type: "completed" });
    first.close();
    await vi.waitFor(() => {
      expect(runtime.cancellations).toContainEqual({
        reason: "playback-failed",
        turnId: "turn-1",
      });
    });

    expect(runtime.requests.map((request) => request.turnId)).toEqual(["turn-1"]);
  });

  it.each(["result", "throw"] as const)(
    "does not release playback fencing when cancel %s fails",
    async (cancellationFailure) => {
      const first = new EventStream<ConversationRuntimeEvent>();
      const second = closedStream([
        { attemptId: "attempt-2", type: "accepted" },
        { attemptId: "attempt-2", type: "completed" },
      ]);
      const runtime = new ScriptedRuntime([first, second]);
      const playback = new FailingCancellationPlayback(cancellationFailure);
      const coordinator = new ConversationCoordinator({ playback, runtime });

      await coordinator.handleFinalizedTurn(input("turn-1", 0));
      await coordinator.handleFinalizedTurn(input("turn-2", 1));
      first.push({ attemptId: "attempt-1", type: "accepted" });
      first.push({
        attemptId: "attempt-1",
        channels: 1,
        format: "pcm_s16le",
        sampleRateHz: 48_000,
        type: "audio-start",
      });
      await vi.waitFor(() => {
        expect(playback.sessions).toHaveLength(1);
      });

      first.push({ attemptId: "attempt-1", reason: "superseded", type: "cancelled" });
      await vi.waitFor(() => {
        expect(playback.sessions[0]?.cancelReasons).toEqual(["superseded"]);
      });
      expect(runtime.requests.map((request) => request.turnId)).toEqual(["turn-1"]);

      playback.sessions[0]?.complete(200);
      await vi.waitFor(() => {
        expect(runtime.requests.map((request) => request.turnId)).toEqual(["turn-1", "turn-2"]);
      });
      first.close();
      await coordinator.whenIdle("meeting-1");
    },
  );
});
