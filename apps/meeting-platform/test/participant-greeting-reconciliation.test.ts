import { expect, it, vi } from "vitest";

import {
  fixture,
  logger,
  occurredAt,
  russianParticipantId,
} from "./participant-greeting-bridge.support.js";
import { MemoryOneShotReceipts } from "./participant-greeting-receipt-memory.js";

it("keeps one durable command through direct, prepared fallback, and restart", async () => {
  const receipts = new MemoryOneShotReceipts();
  const context = fixture(true, "ru", logger, () => 321, (selection) =>
    selection.speech === "Привет!"
      ? {
          cueId: "anonymous-ru-v1",
          pcmChunks: [Uint8Array.of(1, 2)],
          playbackAttemptId: "registry-id-must-not-escape",
        }
      : null,
  { oneShotReceipts: receipts });
  context.coordinator.playbackSettlements.push("unplayed");

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  await context.bridge.settle();

  const commandIds = [
    context.coordinator.calls[0]?.playbackAttemptId,
    commandId(context.coordinator.preparedCalls[0]),
  ];
  expect(context.coordinator.calls).toHaveLength(1);
  expect(context.coordinator.preparedCalls).toHaveLength(1);
  expect(new Set(commandIds)).toEqual(new Set([
    `participant-greeting:${russianParticipantId}`,
  ]));
  expect(receipts.state("greeting", "recording-1", russianParticipantId)).toBe("played");
  const restarted = fixture(true, "ru", logger, () => 654, undefined, {
    oneShotReceipts: receipts,
  });
  restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
  await restarted.bridge.settle();
  expect(restarted.coordinator.calls).toEqual([]);
  expect(restarted.coordinator.preparedCalls).toEqual([]);
});

it("persists audible prepared-fallback start through a transient receipt outage", async () => {
  const receipts = new MemoryOneShotReceipts();
  const confirmStarted = receipts.confirmGreetingStarted.bind(receipts);
  let confirmCalls = 0;
  receipts.confirmGreetingStarted = (input) => {
    confirmCalls += 1;
    return confirmCalls === 1
      ? Promise.reject(new Error("synthetic transient provider-start outage"))
      : confirmStarted(input);
  };
  const context = fixture(true, "ru", logger, () => 321, (selection) =>
    selection.speech === "Привет!"
      ? {
          cueId: "anonymous-ru-v1",
          pcmChunks: [Uint8Array.of(1, 2)],
          playbackAttemptId: "registry-id-must-not-escape",
        }
      : null,
  { oneShotReceipts: receipts });
  context.coordinator.playbackSettlements.push("unplayed");

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  await context.bridge.settle();

  expect(confirmCalls).toBe(2);
  expect(context.coordinator.calls).toHaveLength(1);
  expect(context.coordinator.preparedCalls).toHaveLength(1);
  expect(receipts.state("greeting", "recording-1", russianParticipantId)).toBe("played");
});

it("reclaims an ambiguously committed command on same-process obligation replay", async () => {
  const receipts = new MemoryOneShotReceipts();
  const begin = receipts.beginGreetingAttempt.bind(receipts);
  let ambiguous = true;
  receipts.beginGreetingAttempt = async (input) => {
    await begin(input);
    if (ambiguous) {
      ambiguous = false;
      throw new Error("synthetic commit result was lost");
    }
  };
  const context = fixture(true, "ru", logger, () => 321, undefined, {
    oneShotReceipts: receipts,
  });

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  await expect(context.bridge.settleAcceptance(russianParticipantId)).resolves.toBe(false);
  expect(context.coordinator.calls).toEqual([]);
  expect(receipts.state("greeting", "recording-1", russianParticipantId)).toBe("commanded");

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  await expect(context.bridge.settleAcceptance(russianParticipantId)).resolves.toBe(true);
  expect(context.coordinator.calls).toHaveLength(1);
  expect(context.coordinator.calls[0]?.playbackAttemptId)
    .toBe(`participant-greeting:${russianParticipantId}`);
  expect(receipts.state("greeting", "recording-1", russianParticipantId)).toBe("played");
});

it("records initial-roster presence without inventing a join deadline", async () => {
  const context = fixture(true, "ru", logger, () => 321);

  context.bridge.observeParticipants([russianParticipantId]);
  await context.bridge.settle();
  expect(context.coordinator.calls).toEqual([]);

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  await context.bridge.settle();
  expect(context.coordinator.calls).toHaveLength(1);
});

it("reconciles a thirteenth join racing the active drain before its playback", async () => {
  const receipts = new MemoryOneShotReceipts();
  const context = fixture(true, "ru", logger, () => 321, undefined, {
    oneShotReceipts: receipts,
  });
  const admitted = Array.from({ length: 12 }, (_, index) => `drain-human-${index + 1}`);
  context.coordinator.onPlaybackSettlement = () => {
    context.bridge.participantJoined("drain-human-13", occurredAt);
  };

  context.bridge.participantsPresent(admitted, occurredAt);
  await context.bridge.settle();

  expect(context.coordinator.calls).toHaveLength(1);
  expect(receipts.state("greeting", "recording-1", "drain-human-13"))
    .toBe("suppressed_capacity");
});

it("atomically expires a commanded greeting outside provider dedup retention", async () => {
  let now = 321;
  const receipts = new MemoryOneShotReceipts(() => now);
  const reserved = await receipts.reserve({
    kind: "greeting",
    leaseSeconds: 120,
    meetingId: "recording-1",
    subjectId: russianParticipantId,
  });
  expect(reserved.status).toBe("reserved");
  if (reserved.status !== "reserved") {
    return;
  }
  const providerCommandId = reserved.providerCommandId ??
    `participant-greeting:${russianParticipantId}`;
  await receipts.beginGreetingAttempt({
    kind: "greeting",
    leaseToken: reserved.leaseToken,
    locale: "ru",
    meetingId: "recording-1",
    prompt: "Привет, Саша!",
    providerCommandId,
    subjectId: russianParticipantId,
  });
  receipts.expireReservations();
  now = 1_200_321;
  const restarted = fixture(true, "ru", logger, () => now, undefined, {
    oneShotReceipts: receipts,
  });

  restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
  await restarted.bridge.settle();

  expect(restarted.coordinator.calls).toEqual([]);
  expect(receipts.state("greeting", "recording-1", russianParticipantId))
    .toBe("suppressed_ambiguous");
  const terminalRestart = fixture(true, "ru", logger, () => now + 1, undefined, {
    oneShotReceipts: receipts,
  });
  terminalRestart.bridge.participantsRestored([russianParticipantId], occurredAt);
  await terminalRestart.bridge.settle();
  expect(terminalRestart.coordinator.calls).toEqual([]);
});

it.each([
  { label: "last millisecond inside", restartAt: 120_320 },
  { label: "exact boundary", restartAt: 120_321 },
  { label: "one millisecond over", restartAt: 120_322 },
])("emits zero audio for a commanded receipt after the join deadline at the $label", async ({
  restartAt,
}) => {
  let now = 321;
  const receipts = new MemoryOneShotReceipts(() => now);
  const reserved = await receipts.reserve({
    kind: "greeting", leaseSeconds: 120, meetingId: "recording-1",
    subjectId: russianParticipantId,
  });
  expect(reserved.status).toBe("reserved");
  if (reserved.status !== "reserved") { return; }
  const providerCommandId = reserved.providerCommandId!;
  await receipts.beginGreetingAttempt({
    kind: "greeting", leaseToken: reserved.leaseToken, locale: "ru",
    meetingId: "recording-1", prompt: "Привет, Саша!", providerCommandId,
    subjectId: russianParticipantId,
  });
  receipts.expireReservations();
  now = restartAt;
  const restarted = fixture(true, "ru", logger, () => now, undefined, {
    oneShotReceipts: receipts,
  });
  restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
  await restarted.bridge.settle();

  expect(restarted.coordinator.calls).toEqual([]);
  expect(receipts.state("greeting", "recording-1", russianParticipantId))
    .toMatch(/^suppressed_/u);
});

it("does not invoke the provider when recovery admission crosses the boundary", async () => {
  let now = 321;
  const receipts = new MemoryOneShotReceipts(() => now);
  const reserved = await receipts.reserve({
    kind: "greeting", leaseSeconds: 120, meetingId: "recording-1",
    subjectId: russianParticipantId,
  });
  if (reserved.status !== "reserved") { return; }
  await receipts.beginGreetingAttempt({
    kind: "greeting", leaseToken: reserved.leaseToken, locale: "ru",
    meetingId: "recording-1", prompt: "Привет, Саша!",
    providerCommandId: reserved.providerCommandId!, subjectId: russianParticipantId,
  });
  receipts.expireReservations();
  const begin = receipts.beginGreetingAttempt.bind(receipts);
  receipts.beginGreetingAttempt = async (input) => {
    await begin(input);
    now = 120_321;
  };
  now = 120_320;
  const restarted = fixture(true, "ru", logger, () => now, undefined, {
    oneShotReceipts: receipts,
  });
  restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
  await restarted.bridge.settle();

  expect(restarted.coordinator.calls).toEqual([]);
  expect(receipts.state("greeting", "recording-1", russianParticipantId))
    .toBe("suppressed_stale");
});

it("retries provider-start persistence internally without reissuing audio", async () => {
  const receipts = new MemoryOneShotReceipts();
  const confirmStarted = receipts.confirmGreetingStarted.bind(receipts);
  let confirmCalls = 0;
  receipts.confirmGreetingStarted = async (input) => {
    confirmCalls += 1;
    if (confirmCalls === 1) {
      throw new Error("synthetic transient provider-start write failure");
    }
    await confirmStarted(input);
  };
  const context = fixture(true, "ru", logger, () => 321, undefined, {
    oneShotReceipts: receipts,
  });

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  await context.bridge.settle();

  expect(confirmCalls).toBe(2);
  expect(context.coordinator.calls).toHaveLength(1);
  expect(receipts.state("greeting", "recording-1", russianParticipantId)).toBe("played");
});

it("terminalizes repeated provider-start persistence failure without replay", async () => {
  const receipts = new MemoryOneShotReceipts();
  let confirmCalls = 0;
  receipts.confirmGreetingStarted = () => {
    confirmCalls += 1;
    return Promise.reject(new Error("synthetic persistent provider-start write failure"));
  };
  const context = fixture(true, "ru", logger, () => 321, undefined, {
    oneShotReceipts: receipts,
  });

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  await context.bridge.settle();

  expect(confirmCalls).toBe(3);
  expect(context.coordinator.calls).toHaveLength(1);
  expect(receipts.state("greeting", "recording-1", russianParticipantId))
    .toBe("suppressed_ambiguous");
  const restarted = fixture(true, "ru", logger, () => 654, undefined, {
    oneShotReceipts: receipts,
  });
  restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
  await restarted.bridge.settle();
  expect(restarted.coordinator.calls).toEqual([]);
});

it("keeps a confirmation plus settlement outage at-most-once across restart", async () => {
  let now = 321;
  const receipts = new MemoryOneShotReceipts(() => now);
  const confirmStarted = receipts.confirmGreetingStarted.bind(receipts);
  const settleGreeting = receipts.settleGreeting.bind(receipts);
  receipts.confirmGreetingStarted = () =>
    Promise.reject(new Error("synthetic confirmation store outage"));
  receipts.settleGreeting = () =>
    Promise.reject(new Error("synthetic settlement store outage"));
  const first = fixture(true, "ru", logger, () => now, undefined, {
    oneShotReceipts: receipts,
  });
  first.bridge.participantJoined(russianParticipantId, occurredAt);
  await first.bridge.settle();
  const firstCommandId = first.coordinator.calls[0]?.playbackAttemptId;
  expect(receipts.state("greeting", "recording-1", russianParticipantId)).toBe("commanded");

  receipts.confirmGreetingStarted = confirmStarted;
  receipts.settleGreeting = settleGreeting;
  receipts.expireReservations();
  now = 60_321;
  const restarted = fixture(true, "ru", logger, () => now, undefined, {
    oneShotReceipts: receipts,
  });
  restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
  await restarted.bridge.settle();

  expect(firstCommandId).toBe(`participant-greeting:${russianParticipantId}`);
  expect(restarted.coordinator.calls).toEqual([]);
  expect(receipts.state("greeting", "recording-1", russianParticipantId))
    .toBe("suppressed_stale");
});

it("fences a restart race and duplicate provider callback with one command identity", async () => {
  const receipts = new MemoryOneShotReceipts();
  const confirmStarted = receipts.confirmGreetingStarted.bind(receipts);
  let confirmCalls = 0;
  let releaseFirstConfirm!: () => void;
  const firstConfirmBlocked = new Promise<void>((resolve) => {
    releaseFirstConfirm = resolve;
  });
  receipts.confirmGreetingStarted = async (input) => {
    confirmCalls += 1;
    if (confirmCalls === 1) {
      await firstConfirmBlocked;
    }
    await confirmStarted(input);
  };
  const first = fixture(true, "ru", logger, () => 321, undefined, {
    oneShotReceipts: receipts,
  });
  first.bridge.participantJoined(russianParticipantId, occurredAt);
  const firstSettlement = first.bridge.settle();
  await vi.waitFor(() => { expect(confirmCalls).toBe(1); });

  receipts.expireReservations();
  const restarted = fixture(true, "ru", logger, () => 654, undefined, {
    oneShotReceipts: receipts,
  });
  restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
  await restarted.bridge.settle();
  releaseFirstConfirm();
  await firstSettlement;

  const commandIds = [
    first.coordinator.calls[0]?.playbackAttemptId,
    restarted.coordinator.calls[0]?.playbackAttemptId,
  ];
  expect(commandIds).toHaveLength(2);
  expect(new Set(commandIds).size).toBe(1);
  expect(receipts.state("greeting", "recording-1", russianParticipantId)).toBe("played");
});

function commandId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null ||
    !("playbackAttemptId" in value) || typeof value.playbackAttemptId !== "string") {
    return undefined;
  }
  return value.playbackAttemptId;
}
