import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
} from "@discord-meeting/meeting-core/live-meeting";
import { afterEach, expect, it, vi } from "vitest";

import { PlatformLiveMeetingRuntime } from "../../src/live-meeting-runtime.js";
import type { LiveMeetingRuntimeDependencies } from "../../src/live-runtime/contracts.js";
import {
  ConversationCoordinatorProbe,
  LiveTranscriberStub,
  logger,
  MemoryLiveMeetingRepository,
  ProjectionStub,
  started,
  SummaryStub,
} from "./live-runtime-fixtures.js";

type LoggedEvent = {
  readonly fields: Readonly<Record<string, unknown>> | undefined;
  readonly message: string;
};

afterEach(() => vi.useRealTimers());

function greetingRuntime(
  meetings: MemoryLiveMeetingRepository,
  coordinator: ConversationCoordinatorProbe,
  isPlaybackReady: () => boolean,
  info?: (message: string, fields?: Readonly<Record<string, unknown>>) => void,
  finalizedMemory?: LiveMeetingRuntimeDependencies["finalizedMemory"],
): PlatformLiveMeetingRuntime {
  return new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    conversation: {
      coordinator,
      greetings: {
        defaultLocale: "ru",
        excludedParticipantIds: ["4533228054724346087"],
        isPlaybackReady: () => isPlaybackReady(),
        profiles: {
          "1533228054724346087": {
            displayName: "Александр Смирнов",
            greetingLocale: "ru",
            spokenName: "Саша",
          },
          "2533228054724346087": {
            displayName: "Alex Smith",
            greetingLocale: "en",
            spokenName: "Alex",
          },
        },
      },
      locale: "auto",
      nowMilliseconds: () => Date.now(),
      systemPrompt: "Answer briefly.",
      voiceProfileId: "voice-profile",
    },
    finishMeeting: new FinishLiveMeeting(meetings),
    ...(finalizedMemory === undefined ? {} : { finalizedMemory }),
    logger: info === undefined ? logger : { ...logger, info },
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector: new ProjectionStub(),
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber: new LiveTranscriberStub(),
  });
}

it("routes initial joins and reconnects through one meeting-local greeting", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const coordinator = new ConversationCoordinatorProbe(meetings);
  let playbackReady = false;
  const runtime = greetingRuntime(meetings, coordinator, () => playbackReady);

  await runtime.acceptLifecycle(started("recording-live-1", [
    "1533228054724346087",
    "3533228054724346087",
    "4533228054724346087",
  ]));
  expect(coordinator.proactiveCalls).toEqual([]);

  playbackReady = true;
  await vi.advanceTimersByTimeAsync(100);
  await vi.waitFor(() => {
    expect(coordinator.proactiveCalls).toHaveLength(2);
  });
  expect(coordinator.proactiveCalls[0]).toMatchObject({
    locale: "ru",
    prompt: "Привет!",
    speakerId: "3533228054724346087",
  });
  expect(coordinator.proactiveCalls[1]).toMatchObject({
    locale: "ru",
    prompt: "Привет, Саша!",
    speakerId: "1533228054724346087",
  });

  vi.setSystemTime("2026-08-02T10:01:00.000Z");
  await runtime.acceptLifecycle({
    occurredAt: "2026-08-02T10:01:00.000Z",
    participantId: "2533228054724346087",
    recordingId: "recording-live-1",
    type: "participant.joined",
  });
  await vi.waitFor(() => {
    expect(coordinator.proactiveCalls).toHaveLength(3);
  });
  expect(coordinator.proactiveCalls[2]).toMatchObject({
    locale: "en",
    prompt: "Hi, Alex!",
    speakerId: "2533228054724346087",
  });

  vi.setSystemTime("2026-08-02T10:02:00.000Z");
  for (const type of ["participant.left", "participant.joined"] as const) {
    await runtime.acceptLifecycle({
      occurredAt: "2026-08-02T10:02:00.000Z",
      participantId: "1533228054724346087",
      recordingId: "recording-live-1",
      type,
    });
  }
  await vi.advanceTimersByTimeAsync(100);
  expect(coordinator.proactiveCalls).toHaveLength(3);

  await runtime.close();
});

it("awaits active conversation cancellation before accepting connection loss", async () => {
  const meetings = new MemoryLiveMeetingRepository();
  const coordinator = new ConversationCoordinatorProbe(meetings);
  const runtime = greetingRuntime(meetings, coordinator, () => true);

  await runtime.acceptLifecycle(started());
  await runtime.acceptLifecycle({
    occurredAt: "2026-08-02T10:00:01.000Z",
    recordingId: "recording-live-1",
    type: "meeting.connection_lost",
  });

  expect(coordinator.disconnectCalls).toEqual(["recording-live-1"]);
  await runtime.close();
});

it("cancels departed participant work before a stalled roster projection", async () => {
  const meetings = new MemoryLiveMeetingRepository();
  const coordinator = new ConversationCoordinatorProbe(meetings);
  let releaseRemoval!: () => void;
  const removal = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });
  const finalizedMemory = {
    finishMeeting: async () => {},
    observeHuman: async () => "accepted" as const,
    registerMeeting: async () => "accepted" as const,
    removeHuman: async () => {
      await removal;
      return "accepted" as const;
    },
    sealMeeting: async () => "accepted" as const,
    synchronizeMeeting: async () => {},
  };
  const runtime = greetingRuntime(
    meetings,
    coordinator,
    () => true,
    undefined,
    finalizedMemory,
  );
  await runtime.acceptLifecycle(started());

  const departing = runtime.acceptLifecycle({
    memoryHumanObservation: {
      actorId: "participant-1",
      producerRevision: "synthetic-r1",
    },
    occurredAt: "2026-08-02T10:00:01.000Z",
    participantId: "participant-1",
    recordingId: "recording-live-1",
    type: "participant.left",
  });
  await vi.waitFor(() => {
    expect(coordinator.participantLeftCalls).toEqual([{
      meetingId: "recording-live-1",
      participantId: "participant-1",
    }]);
  });
  releaseRemoval();
  await departing;
  await runtime.close();
});

it("does not suppress an unplayed greeting merely because a meeting is restored", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const firstCoordinator = new ConversationCoordinatorProbe(meetings);
  const firstRuntime = greetingRuntime(meetings, firstCoordinator, () => false);
  const event = started("recording-live-1", ["1533228054724346087"]);
  await firstRuntime.acceptLifecycle(event);

  const restoredCoordinator = new ConversationCoordinatorProbe(meetings);
  const restoredRuntime = greetingRuntime(meetings, restoredCoordinator, () => true);
  await restoredRuntime.acceptLifecycle(event);
  await vi.advanceTimersByTimeAsync(100);
  expect(restoredCoordinator.proactiveCalls).toHaveLength(1);
  expect(restoredCoordinator.proactiveCalls[0]).toMatchObject({
    prompt: "Привет, Саша!",
    speakerId: "1533228054724346087",
  });

  vi.setSystemTime("2026-08-02T10:01:00.000Z");
  await restoredRuntime.acceptLifecycle({
    occurredAt: "2026-08-02T10:01:00.000Z",
    participantId: "2533228054724346087",
    recordingId: "recording-live-1",
    type: "participant.joined",
  });
  await vi.waitFor(() => {
    expect(restoredCoordinator.proactiveCalls).toHaveLength(2);
  });
  expect(restoredCoordinator.proactiveCalls[1]).toMatchObject({
    prompt: "Hi, Alex!",
    speakerId: "2533228054724346087",
  });

  await restoredRuntime.close();
  await firstRuntime.close();
});

it.each([10, 20])(
  "greets a fresh participant joining at meeting age +%i minutes",
  async (meetingAgeMinutes) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-02T10:00:00.000Z");
    const meetings = new MemoryLiveMeetingRepository();
    const coordinator = new ConversationCoordinatorProbe(meetings);
    const runtime = greetingRuntime(meetings, coordinator, () => true);
    await runtime.acceptLifecycle(started("recording-live-1", []));

    const occurredAt = `2026-08-02T10:${String(meetingAgeMinutes).padStart(2, "0")}:00.000Z`;
    vi.setSystemTime(occurredAt);
    await runtime.acceptLifecycle({
      occurredAt,
      participantId: "2533228054724346087",
      recordingId: "recording-live-1",
      type: "participant.joined",
    });
    await vi.waitFor(() => expect(coordinator.proactiveCalls).toHaveLength(1));
    expect(coordinator.proactiveCalls[0]).toMatchObject({
      prompt: "Hi, Alex!",
      speakerId: "2533228054724346087",
    });
    await runtime.close();
  },
);

it.each([10, 20])(
  "terminalizes a participant lifecycle delivered %i minutes after occurredAt",
  async (deliveryDelayMinutes) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-02T10:00:00.000Z");
    const meetings = new MemoryLiveMeetingRepository();
    const coordinator = new ConversationCoordinatorProbe(meetings);
    const runtime = greetingRuntime(meetings, coordinator, () => true);
    await runtime.acceptLifecycle(started("recording-live-1", []));

    vi.setSystemTime(`2026-08-02T10:${String(deliveryDelayMinutes).padStart(2, "0")}:00.000Z`);
    await runtime.acceptLifecycle({
      occurredAt: "2026-08-02T10:00:00.000Z",
      participantId: "2533228054724346087",
      recordingId: "recording-live-1",
      type: "participant.joined",
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(coordinator.proactiveCalls).toEqual([]);
    await runtime.close();
  },
);

it("logs privacy-safe SUT participant lifecycle receipts for reconnect proof", async () => {
  vi.useFakeTimers();
  const logged: LoggedEvent[] = [];
  const meetings = new MemoryLiveMeetingRepository();
  const runtime = greetingRuntime(
    meetings,
    new ConversationCoordinatorProbe(meetings),
    () => false,
    (message, fields) => {
      logged.push({ fields, message });
    },
  );
  await runtime.acceptLifecycle(started("recording-live-1"));
  for (const [type, occurredAt] of [
    ["participant.left", "2026-08-02T10:02:00.000Z"],
    ["participant.joined", "2026-08-02T10:02:01.000Z"],
  ] as const) {
    await runtime.acceptLifecycle({
      occurredAt,
      participantId: "2533228054724346087",
      recordingId: "recording-live-1",
      type,
    });
  }

  expect(logged.filter(({ message }) =>
    message === "Live participant lifecycle accepted"
  )).toEqual([
    {
      fields: {
        eventType: "participant.left",
        meetingId: "recording-live-1",
        occurredAt: "2026-08-02T10:02:00.000Z",
        participantId: "2533228054724346087",
      },
      message: "Live participant lifecycle accepted",
    },
    {
      fields: {
        eventType: "participant.joined",
        meetingId: "recording-live-1",
        occurredAt: "2026-08-02T10:02:01.000Z",
        participantId: "2533228054724346087",
      },
      message: "Live participant lifecycle accepted",
    },
  ]);
  await runtime.close();
});
