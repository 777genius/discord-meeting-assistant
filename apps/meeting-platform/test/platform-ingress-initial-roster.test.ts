import { afterEach, describe, expect, it, vi } from "vitest";

import { createCraigInboundRoutesPlugin } from "../src/adapters/inbound/craig/craig-inbound-routes.js";
import type { DerivedGreetingObligation } from "../src/application/derived-greeting-obligations.js";
import { PlatformRecordingIngress } from "../src/application/platform-ingress.js";
import type {
  DerivedLiveLifecycleEvent,
  RecordingLifecycleCommand,
} from "../src/application/recording-ingress.js";
import {
  createFastifyPlatformHttpHost,
  type FastifyPlatformHttpHost,
} from "../src/http/fastify-platform-http-host.js";
import {
  fixture as greetingFixture,
  occurredAt as greetingOccurredAt,
  russianParticipantId,
} from "./participant-greeting-bridge.support.js";
import { MemoryOneShotReceipts } from "./participant-greeting-receipt-memory.js";

const token = "test-craig-bearer-token";
const source = {
  roomId: "1533228823045214398",
  scopeId: "1533228590643155034",
} as const;
const lowHumanId = "1533227577286852649";
const highHumanId = "1533228054724346087";
const hosts: FastifyPlatformHttpHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(async (host) => host.close()));
});

function createHarness(
  nowMilliseconds: () => number,
  failPersistenceAt: number | null = null,
) {
  const delivered = new Set<string>();
  const expired = new Set<string>();
  const obligations = new Map<string, DerivedGreetingObligation>();
  const order: string[] = [];
  let persistenceCount = 0;
  const acceptLifecycle = vi.fn(async (event: DerivedLiveLifecycleEvent) => {
    if (event.type === "meeting.started") {
      order.push(`start:${event.participantIds.join(",")}`);
    } else if (event.type === "participant.joined" || event.type === "participant.left") {
      order.push(`${event.type}:${event.participantId}`);
    }
    return "accepted" as const;
  });
  const ingress = new PlatformRecordingIngress({
    dispatcher: { dispatchPending: async () => ({ dispatched: 0, failed: 0 }) },
    failureClassifier: { classify: () => null },
    greetingObligations: {
      accept: async (obligation) => {
        persistenceCount += 1;
        order.push(`persist:${obligation.participantId}`);
        if (persistenceCount === failPersistenceAt) {
          throw new Error("persistence failed");
        }
        obligations.set(obligation.eventId, obligation);
      },
      listPending: async () => [...obligations.values()].filter(({ eventId }) =>
        !delivered.has(eventId) && !expired.has(eventId)
      ),
      markDelivered: async (eventId) => {
        order.push(`delivered:${eventId}`);
        delivered.add(eventId);
      },
      markExpired: async (eventId) => {
        order.push(`expired:${eventId}`);
        expired.add(eventId);
      },
    },
    ingress: {
      ingestAuthoritativeTrack: async () => {
        throw new Error("not used");
      },
      ingestLifecycleEvent: async (event) => ({
        kind: "accepted" as const,
        recordingId: event.recordingId,
        replayed: false,
      }),
      ingestPacketBatch: async () => ({
        acceptedPackets: 0,
        duplicatePackets: 0,
        recordingId: "recording-initial",
      }),
    },
    live: {
      acceptLifecycle,
      acceptVoiceBatch: () => {},
      prepareForAuthoritativeFinal: () => {},
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    metrics: { recordDerivedLiveFailure: () => {}, recordIngress: () => {} },
    nowMilliseconds,
    outbox: { recordAndSchedule: async () => {} },
    publicationTargets: { resolve: async () => "77777777777777777" },
  });
  return { acceptLifecycle, delivered, expired, ingress, obligations, order };
}

function startedV2(
  occurredAt = "2026-08-02T00:00:00.000Z",
): Extract<RecordingLifecycleCommand, { schemaVersion: 2; type: "meeting.started" }> {
  return {
    actors: [
      { actorId: highHumanId, kind: "human" },
      { actorId: "1533228823045214398", kind: "automation" },
      { actorId: lowHumanId, kind: "human" },
    ],
    eventId: "recording-initial:start",
    occurredAt,
    recordingId: "recording-initial",
    schemaVersion: 2,
    source,
    type: "meeting.started",
  };
}

describe("initial-roster durable greeting ingress", () => {
  it("parses a V3 producer event and canonicalizes reversed wire order everywhere", async () => {
    const occurredAt = "2026-08-02T00:00:00.123456Z";
    const harness = createHarness(() => Date.parse(occurredAt) + 1);
    const host = createFastifyPlatformHttpHost({
      bindAddress: "127.0.0.1",
      port: 0,
      routePlugins: [createCraigInboundRoutesPlugin({
        bearerToken: token,
        configuration: { listActiveGuildVoiceChannels: async () => [] },
        ingress: harness.ingress,
      })],
    });
    hosts.push(host);

    const response = await host.inject({
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
      payload: {
        actorObservationState: "consistent",
        actorSemanticsVersion: 1,
        actors: [
          { actorId: highHumanId, kind: "human" },
          { actorId: "1533228823045214398", kind: "automation" },
          { actorId: lowHumanId, kind: "human" },
        ],
        channelId: source.roomId,
        eventId: "recording-initial:start-v3",
        guildId: source.scopeId,
        occurredAt,
        producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
        producerRevision: "a".repeat(40),
        recordingId: "recording-initial",
        rosterState: "unsealed",
        schemaVersion: 3,
        type: "meeting.started",
      },
      url: "/v1/craig/events",
    });

    expect(response.statusCode).toBe(202);
    expect(harness.order).toEqual([
      `persist:${lowHumanId}`,
      `persist:${highHumanId}`,
      `start:${lowHumanId},${highHumanId}`,
      `participant.joined:${lowHumanId}`,
      `delivered:recording-initial:start-v3:initial:${lowHumanId}`,
      `participant.joined:${highHumanId}`,
      `delivered:recording-initial:start-v3:initial:${highHumanId}`,
    ]);
    expect([...harness.obligations.values()]).toEqual([
      expect.objectContaining({
        memoryHumanObservation: {
          actorId: lowHumanId,
          producerRevision: "a".repeat(40),
        },
        notAfterMilliseconds: Date.parse("2026-08-02T00:00:05.123Z"),
        occurredAt: "2026-08-02T00:00:00.123Z",
        participantId: lowHumanId,
      }),
      expect.objectContaining({ participantId: highHumanId }),
    ]);
  });

  it("does not start derived state when persistence of the second obligation fails", async () => {
    const started = startedV2();
    const harness = createHarness(() => Date.parse(started.occurredAt) + 1, 2);

    await expect(harness.ingress.ingestLifecycle(started)).rejects.toThrow(
      "persistence failed",
    );

    expect(harness.order).toEqual([
      `persist:${lowHumanId}`,
      `persist:${highHumanId}`,
    ]);
    expect(harness.acceptLifecycle).not.toHaveBeenCalled();
  });

  it.each([
    { elapsedMilliseconds: 4_999, expected: "delivered" },
    { elapsedMilliseconds: 5_000, expected: "expired" },
  ])(
    "is $expected at exactly $elapsedMilliseconds ms",
    async ({ elapsedMilliseconds, expected }) => {
      const started = startedV2();
      const oneHumanStart: RecordingLifecycleCommand = {
        ...started,
        actors: [{ actorId: lowHumanId, kind: "human" }],
      };
      const harness = createHarness(() =>
        Date.parse(oneHumanStart.occurredAt) + elapsedMilliseconds
      );

      await harness.ingress.ingestLifecycle(oneHumanStart);

      const obligationId = `${oneHumanStart.eventId}:initial:${lowHumanId}`;
      expect(harness.delivered.has(obligationId)).toBe(expected === "delivered");
      expect(harness.expired.has(obligationId)).toBe(expected === "expired");
      expect(harness.order.some((entry) => entry.startsWith("participant.joined:")))
        .toBe(expected === "delivered");
    },
  );

  it("keeps the completed receipt terminal across replay and restart", async () => {
    const receipts = new MemoryOneShotReceipts();
    const obligationIds: string[] = [];
    const started: RecordingLifecycleCommand = {
      actors: [{ actorId: russianParticipantId, kind: "human" }],
      eventId: "recording-1:initial-replay",
      occurredAt: greetingOccurredAt,
      recordingId: "recording-1",
      schemaVersion: 2,
      source,
      type: "meeting.started",
    };
    const createIngress = (context: ReturnType<typeof greetingFixture>) =>
      new PlatformRecordingIngress({
        dispatcher: { dispatchPending: async () => ({ dispatched: 0, failed: 0 }) },
        failureClassifier: { classify: () => null },
        greetingObligations: {
          accept: async (obligation) => void obligationIds.push(obligation.eventId),
          listPending: async () => [],
          markDelivered: async () => {},
          markExpired: async () => {},
        },
        ingress: {
          ingestAuthoritativeTrack: async () => {
            throw new Error("not used");
          },
          ingestLifecycleEvent: async () => ({
            kind: "accepted" as const,
            recordingId: started.recordingId,
            replayed: true,
          }),
          ingestPacketBatch: async () => ({
            acceptedPackets: 0,
            duplicatePackets: 0,
            recordingId: started.recordingId,
          }),
        },
        live: {
          acceptLifecycle: async (event) => {
            if (event.type === "meeting.started") {
              context.bridge.observeParticipants(event.participantIds);
            } else if (event.type === "participant.joined") {
              context.bridge.participantJoined(event.participantId, event.occurredAt);
              return await context.bridge.settleAcceptance(event.participantId)
                ? "accepted" as const
                : "retry" as const;
            }
            return "accepted" as const;
          },
          acceptVoiceBatch: () => {},
          prepareForAuthoritativeFinal: () => {},
        },
        logger: { debug: () => {}, info: () => {}, warn: () => {} },
        metrics: { recordDerivedLiveFailure: () => {}, recordIngress: () => {} },
        nowMilliseconds: () => 322,
        outbox: { recordAndSchedule: async () => {} },
        publicationTargets: { resolve: async () => "77777777777777777" },
      });
    const first = greetingFixture(true, "ru", undefined, () => 322, undefined, {
      oneShotReceipts: receipts,
    });
    await createIngress(first).ingestLifecycle(started);
    expect(first.coordinator.calls).toHaveLength(1);

    const restarted = greetingFixture(true, "ru", undefined, () => 323, undefined, {
      oneShotReceipts: receipts,
    });
    await createIngress(restarted).ingestLifecycle(started);

    const obligationId = `${started.eventId}:initial:${russianParticipantId}`;
    expect(obligationIds).toEqual([obligationId, obligationId]);
    expect(restarted.coordinator.calls).toEqual([]);
    expect(restarted.coordinator.preparedCalls).toEqual([]);
  });
});
