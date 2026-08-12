import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
} from "@discord-meeting/meeting-core/live-meeting";
import { afterEach, expect, it, vi } from "vitest";

import { PlatformLiveMeetingRuntime } from "../../src/live-meeting-runtime.js";
import {
  ConversationCoordinatorProbe,
  LiveTranscriberStub,
  logger,
  MemoryLiveMeetingRepository,
  ProjectionStub,
  started,
  SummaryStub,
} from "./live-runtime-fixtures.js";

afterEach(() => vi.useRealTimers());

function greetingRuntime(
  meetings: MemoryLiveMeetingRepository,
  coordinator: ConversationCoordinatorProbe,
  isPlaybackReady: () => boolean,
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
      nowMilliseconds: () => performance.now(),
      systemPrompt: "Answer briefly.",
      voiceProfileId: "voice-profile",
    },
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
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

it("suppresses initial greeting replay when an active meeting is restored", async () => {
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
  expect(restoredCoordinator.proactiveCalls).toEqual([]);

  await restoredRuntime.acceptLifecycle({
    occurredAt: "2026-08-02T10:01:00.000Z",
    participantId: "2533228054724346087",
    recordingId: "recording-live-1",
    type: "participant.joined",
  });
  await vi.waitFor(() => {
    expect(restoredCoordinator.proactiveCalls).toHaveLength(1);
  });
  expect(restoredCoordinator.proactiveCalls[0]).toMatchObject({
    prompt: "Hi, Alex!",
    speakerId: "2533228054724346087",
  });

  await restoredRuntime.close();
  await firstRuntime.close();
});
