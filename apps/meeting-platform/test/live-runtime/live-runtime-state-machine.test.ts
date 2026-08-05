import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
} from "@discord-meeting/meeting-core";
import { expect, it, vi } from "vitest";

import { PlatformLiveMeetingRuntime } from "../../src/live-meeting-runtime.js";
import { TerminalEndTimeIntents } from "../../src/live-runtime/terminal-end-time-intents.js";
import type {
  LiveMeetingRuntimeDependencies,
  LiveTranscriptionPort,
  LiveTranscriptionSession,
} from "../../src/live-runtime/contracts.js";
import {
  ControlledLiveTranscriberStub,
  ended,
  logger,
  MemoryLiveMeetingRepository,
  packets,
  ProjectionStub,
  started,
  SummaryStub,
} from "./live-runtime-fixtures.js";

type RuntimeOverrides = Partial<Pick<LiveMeetingRuntimeDependencies,
  "finishMeeting" | "startMeeting" | "transcriber"
>>;
type OpenSessionRequest = Parameters<LiveTranscriptionPort["openSession"]>[0];

it("serializes deferred target resolution, packets and terminal events per recording", async () => {
  const meetings = new MemoryLiveMeetingRepository();
  const targetGate = deferred<string | null>();
  const transcriber = new ControlledLiveTranscriberStub();
  const runtime = createRuntime(meetings, { transcriber });
  const startEvent = {
    ...started(),
    publicationTarget: { resolve: () => targetGate.promise },
  };

  const lifecycle = runtime.acceptLifecycle(startEvent);
  const admittedPackets = runtime.acceptVoiceBatch(packets());
  const terminal = runtime.acceptLifecycle(ended());
  await Promise.resolve();
  expect(transcriber.requests).toHaveLength(0);

  targetGate.resolve("1533228891827736657");
  await Promise.all([lifecycle, admittedPackets, terminal]);
  await runtime.settleBeforeFinalPublication("recording-live-1");

  expect(transcriber.requests).toHaveLength(1);
  expect(meetings.snapshot).toMatchObject({ status: "ended" });
  await runtime.acceptVoiceBatch(packets());
  expect(transcriber.requests).toHaveLength(1);
  await runtime.close();
});

it("drains a start admitted before shutdown instead of leaving a ghost live state", async () => {
  const meetings = new MemoryLiveMeetingRepository();
  const actualStart = new StartLiveMeeting({ meetings });
  const startGate = deferred<void>();
  const runtime = createRuntime(meetings, {
    startMeeting: {
      execute: async (input) => {
        await startGate.promise;
        return actualStart.execute(input);
      },
    },
  });

  const lifecycle = runtime.acceptLifecycle(started());
  const closing = runtime.close();
  startGate.resolve();
  await Promise.all([lifecycle, closing]);

  expect(meetings.snapshot).toMatchObject({ status: "ended" });
  await expect(runtime.acceptLifecycle(started())).resolves.toBeUndefined();
  await expect(runtime.acceptLifecycle(ended())).resolves.toBeUndefined();
});

it("propagates a durable start failure and never admits packets into an absent state", async () => {
  const meetings = new MemoryLiveMeetingRepository();
  const transcriber = new ControlledLiveTranscriberStub();
  const runtime = createRuntime(meetings, {
    startMeeting: {
      execute: async () => {
        throw new Error("durable live start failed");
      },
    },
    transcriber,
  });

  await expect(runtime.acceptLifecycle(started())).rejects.toThrow("durable live start failed");
  await runtime.acceptVoiceBatch(packets());

  expect(transcriber.requests).toHaveLength(0);
  expect(meetings.snapshot).toBeNull();
  await runtime.close();
});

it("retains finalizing state after a durable terminal failure and retries through the fence", async () => {
  const meetings = new MemoryLiveMeetingRepository();
  const actualFinish = new FinishLiveMeeting(meetings);
  let failOnce = true;
  const finishMeeting = {
    execute: async (meetingId: string, endedAtMs: number) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("durable live finish failed");
      }
      return actualFinish.execute(meetingId, endedAtMs);
    },
  };
  const runtime = createRuntime(meetings, { finishMeeting });

  await runtime.acceptLifecycle(started());
  await expect(runtime.acceptLifecycle(ended()))
    .rejects.toThrow("durable live finish failed");
  expect(meetings.snapshot).toMatchObject({ status: "active" });

  await expect(runtime.settleBeforeFinalPublication("recording-live-1"))
    .resolves.toBeUndefined();
  expect(meetings.snapshot).toMatchObject({ status: "ended" });
  await runtime.close();
});

it("reports a durable terminal failure during shutdown instead of settling it away", async () => {
  const meetings = new MemoryLiveMeetingRepository();
  const runtime = createRuntime(meetings, {
    finishMeeting: {
      execute: async () => {
        throw new Error("durable shutdown finish failed");
      },
    },
  });

  await runtime.acceptLifecycle(started());
  await expect(runtime.close()).rejects.toBeInstanceOf(AggregateError);

  expect(meetings.snapshot).toMatchObject({ status: "active" });
});

it("finishes a persisted active meeting from an authoritative-final fence after restart", async () => {
  const meetings = new MemoryLiveMeetingRepository();
  await new StartLiveMeeting({ meetings }).execute({
    meetingId: "recording-cold-final",
    publicationTargetId: "1533228891827736657",
    startedAtMs: 0,
  });
  const runtime = createRuntime(meetings);

  await runtime.settleBeforeFinalPublication("recording-cold-final");

  expect(meetings.snapshot).toMatchObject({ status: "ended" });
  await runtime.close();
});

it("coalesces cold authoritative-final work with its later publication fence", async () => {
  const meetings = new MemoryLiveMeetingRepository();
  const finishGate = deferred<"ended" | "not-found" | "reused">();
  const finishMeeting = { execute: vi.fn(async () => finishGate.promise) };
  const runtime = createRuntime(meetings, { finishMeeting });

  runtime.prepareForAuthoritativeFinal("recording-cold-coalesced");
  const fence = runtime.settleBeforeFinalPublication("recording-cold-coalesced");
  await vi.waitFor(() => {
    expect(finishMeeting.execute).toHaveBeenCalledTimes(1);
  });
  finishGate.resolve("ended");
  await fence;

  expect(finishMeeting.execute).toHaveBeenCalledTimes(1);
  await runtime.close();
  expect(finishMeeting.execute).toHaveBeenCalledTimes(1);
});

it("retains a bounded terminal-before-start intent and clears it after durable finish", async () => {
  const meetings = new MemoryLiveMeetingRepository();
  const actualFinish = new FinishLiveMeeting(meetings);
  const finishMeeting = {
    execute: vi.fn((meetingId: string, endedAtMs: number) =>
      actualFinish.execute(meetingId, endedAtMs)
    ),
  };
  const runtime = createRuntime(meetings, { finishMeeting });

  await runtime.acceptLifecycle(ended());
  await runtime.acceptLifecycle(started());

  expect(meetings.snapshot).toMatchObject({ status: "ended" });
  expect(finishMeeting.execute).toHaveBeenCalledTimes(2);
  await runtime.close();
  expect(finishMeeting.execute).toHaveBeenCalledTimes(2);
});

it("bounds and expires unmatched terminal lifecycle intents", () => {
  const intents = new TerminalEndTimeIntents(2, 100);
  intents.remember("recording-1", 10, 0);
  intents.remember("recording-2", 20, 1);
  intents.remember("recording-3", 30, 2);

  expect(intents.recordingIds(2)).toEqual(["recording-2", "recording-3"]);
  expect(intents.recordingIds(102)).toEqual([]);
});

it("keeps provider finals emitted during transcription finish and rejects later callbacks", async () => {
  const meetings = new MemoryLiveMeetingRepository();
  const transcriber = new FinalizeCallbackTranscriber();
  const runtime = createRuntime(meetings, { transcriber });

  await runtime.acceptLifecycle(started());
  await runtime.acceptVoiceBatch(packets());
  const fence = runtime.settleBeforeFinalPublication("recording-live-1");
  await vi.waitFor(() => {
    expect(transcriber.finalizationStarted).toBe(true);
  });
  transcriber.releaseFinish();
  await fence;
  transcriber.emitLateFinal();
  await flushMicrotasks();

  expect(meetings.finalizedTurns.map(({ text }) => text)).toEqual([
    "Final callback during finish.",
  ]);
  await runtime.close();
});

function createRuntime(
  meetings: MemoryLiveMeetingRepository,
  overrides: RuntimeOverrides = {},
): PlatformLiveMeetingRuntime {
  return new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: overrides.finishMeeting ?? new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector: new ProjectionStub(),
      summarizer: new SummaryStub(),
    }),
    startMeeting: overrides.startMeeting ?? new StartLiveMeeting({ meetings }),
    transcriber: overrides.transcriber ?? new ControlledLiveTranscriberStub(),
  });
}

class FinalizeCallbackTranscriber implements LiveTranscriptionPort {
  public finalizationStarted = false;
  private readonly finishGate = deferred<void>();
  private request: OpenSessionRequest | null = null;

  public openSession(request: OpenSessionRequest): Promise<LiveTranscriptionSession> {
    this.request = request;
    return Promise.resolve({
      finalize: () => {
        this.finalizationStarted = true;
        request.onTranscript(transcript(request, "Final callback during finish."));
        return this.finishGate.promise;
      },
      sendPacket: () => Promise.resolve("accepted" as const),
      terminate: () => {},
    });
  }

  public releaseFinish(): void {
    this.finishGate.resolve();
  }

  public emitLateFinal(): void {
    if (this.request !== null) {
      this.request.onTranscript(transcript(this.request, "Late callback after finish."));
    }
  }
}

function transcript(request: OpenSessionRequest, text: string) {
  return {
    endMs: 1_000,
    isFinal: true,
    meetingId: request.meetingId,
    speakerId: request.speakerId,
    startMs: 0,
    text,
  } as const;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

function deferred<Value>(): Deferred<Value> {
  let rejectDeferred!: (reason?: unknown) => void;
  let resolveDeferred!: (value: Value) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    rejectDeferred = reject;
    resolveDeferred = resolve;
  });
  return { promise, reject: rejectDeferred, resolve: resolveDeferred };
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: Value) => void;
}
