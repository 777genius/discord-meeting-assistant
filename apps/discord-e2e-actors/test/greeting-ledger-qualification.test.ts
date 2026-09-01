import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  buildGreetingLedgerQualification,
  greetingReceiptId,
} from "../src/greeting-ledger-qualification.js";
import {
  lateGreetingObservationV1Schema,
  observeNoLateGreeting,
} from "../src/late-greeting-observation.js";
import { OFFICIAL_GREETING_TEST_IDENTITIES } from "../src/thin-remediation-proof.js";

const meetingId = "meeting-1";
const runId = "run-3";
const settledAt = "2026-08-25T00:00:00.000Z";
const digest = "a".repeat(64);

function ledgerRows() {
  return OFFICIAL_GREETING_TEST_IDENTITIES.map((participantId) => ({
    completedAt: settledAt,
    cueKind: "greeting",
    receiptId: greetingReceiptId(meetingId, participantId),
    state: "played",
  }));
}

function lifecycle() {
  const locales = ["ru", "ru", "en", "ru"] as const;
  return {
    events: OFFICIAL_GREETING_TEST_IDENTITIES.map((participantId, index) => ({
      greetingLocale: locales[index]!, observedAt: new Date(950 + index * 1_000).toISOString(),
      participantId, participantNameStatus: index === 1 || index === 2 ? "known" : "unknown",
      turnId: `participant-greeting:${participantId}`, type: "greeting",
    })),
    participantLifecycleReceipts: OFFICIAL_GREETING_TEST_IDENTITIES.map((participantId, index) => ({
      eventType: "participant.joined", observedAt: new Date(900 + index * 1_000).toISOString(),
      occurredAt: new Date(900 + index * 1_000).toISOString(), participantId, type: "participant-lifecycle",
    })),
  };
}

function campaignProof() {
  return {
    observerReadyReceipt: {
      authenticatedObserverBotId: "observer", capturePlan: "addressed-answer",
      intentDigestSha256: digest, intentObservedAt: settledAt, kind: "answer",
      meetingId, planDigestSha256: digest, playbackAttemptId: "answer-attempt",
      protocolVersion: 1, readyPublishedAt: settledAt, runId,
      target: { craigBotId: "craig", guildId: "guild", observerApplicationId: "observer", voiceChannelId: "voice" },
      turnId: "answer-turn", type: "observer-ready",
    },
    plan: {
      captures: Array.from({ length: 6 }, (_, index) => ({
        expectedDuration: { maximumMilliseconds: 1_000, minimumMilliseconds: 500 },
        ordinal: index + 1, outputPath: `/proof/${String(index + 1)}.json`,
        purpose: index < 4 ? "greeting" : index === 4 ? "addressed-answer" : "farewell",
        resolvedAttemptId: `attempt-${String(index + 1)}`,
        resolvedTurnId: index < 4 ? `participant-greeting:${OFFICIAL_GREETING_TEST_IDENTITIES[index]!}` : `turn-${String(index + 1)}`,
        role: `role-${String(index + 1)}`,
      })),
      kind: "conversation-voice-campaign-preflight", status: "validated",
    },
    planDigestSha256: digest, schemaVersion: 1,
  };
}

function capture(participantId: string, index: number) {
  return {
    capture: {
      acceptedDurationMilliseconds: 500, acceptedPacketCount: 2,
      cancellation: { status: "not-observed" },
      endedAt: { epochMilliseconds: 2_000 + index * 1_000, monotonicMilliseconds: 2_000 + index * 1_000 },
      expectedDuration: { maximumMilliseconds: 1_000, minimumMilliseconds: 500 },
      firstPacketAt: { epochMilliseconds: 1_000 + index * 1_000, monotonicMilliseconds: 1_000 + index * 1_000 },
      ignoredDuplicatePacketCount: 0, ignoredLatePacketCount: 0,
      limits: { captureTimeoutMilliseconds: 60_000, maxCaptureDurationMilliseconds: 60_000, maxPcmBytes: 1_000_000 },
      pcm: { byteLength: 1_920, channels: 2, encoding: "s16le",
        nonSilence: { sampleCount: 480, sampleCountAboveThreshold: 480, sampleRatioAboveThreshold: 1, thresholdSample: 1 },
        rms: 0.5, sampleRateHertz: 48_000, sha256: digest },
      startedAt: { epochMilliseconds: 900 + index * 1_000, monotonicMilliseconds: 900 + index * 1_000 },
      termination: "expected-duration-reached",
    },
    correlation: { attemptId: `attempt-${String(index + 1)}`, provenance: "operator-supplied",
      purpose: "greeting", recordingId: null, verification: "not-run",
      turnId: `participant-greeting:${participantId}` },
    kind: "conversation-voice-observer-evidence",
    observer: { applicationId: "observer", authenticatedBotId: "observer", guildId: "guild",
      privateTestGuildConfirmed: true, voiceChannelId: "voice" },
    runId, schemaVersion: 3,
    source: { codec: "opus", craigBotId: "craig",
      decodedPcm: { channels: 2, encoding: "s16le", sampleRateHertz: 48_000 }, receiver: "@discordjs/voice" },
    transcriptVerification: { status: "not-run" },
  };
}

describe("greeting ledger qualification", () => {
  it("joins four real voice captures to their exact durable played receipts", () => {
    const proof = buildGreetingLedgerQualification({
      campaignId: "campaign-1", campaignProof: campaignProof(),
      captures: OFFICIAL_GREETING_TEST_IDENTITIES.map(capture), ledgerRows: ledgerRows(), lifecycle: lifecycle(),
      settlementObservedAt: settledAt,
    });
    expect(proof.participants.map(({ ledger, participantId }) => [participantId, ledger.receiptId]))
      .toEqual(OFFICIAL_GREETING_TEST_IDENTITIES.map((participantId) =>
        [participantId, greetingReceiptId(meetingId, participantId)]));
  });

  it("keeps the same Craig subscription through settlement and twenty quiet minutes", async () => {
    const proof = buildGreetingLedgerQualification({
      campaignId: "campaign-1", campaignProof: campaignProof(),
      captures: OFFICIAL_GREETING_TEST_IDENTITIES.map(capture), ledgerRows: ledgerRows(), lifecycle: lifecycle(),
      settlementObservedAt: settledAt,
    });
    const stream = new Readable({ read() {} });
    let now = Date.parse(settledAt);
    const observation = await observeNoLateGreeting({
      decoder: { decode: (packet) => packet, isPacketAudible: () => false },
      greetingLedgerBytes: JSON.stringify(proof), sourceStream: stream,
      subscriptionStartedAt: "2026-08-24T23:59:00.000Z",
    }, {
      now: () => now,
      restartMeetingPlatform: async () => { now += 1_000; },
      wait: async (milliseconds) => { now += milliseconds; },
      workerIdentity: (() => {
        let calls = 0;
        return async () => ({ containerId: "a".repeat(64), hostProcessId: ++calls });
      })(),
    });
    expect(Date.parse(observation.endedAt) - Date.parse(observation.settlementCompletedAt))
      .toBe(20 * 60_000);
  });

  it.each(["requestedAt", "completedAt"] as const)(
    "rejects retained restart %s after the settlement twenty-minute window",
    (field) => {
      const late = "2026-08-25T00:20:00.001Z";
      const restart = {
        after: { containerId: "b".repeat(64), hostProcessId: 2 },
        before: { containerId: "a".repeat(64), hostProcessId: 1 },
        completedAt: field === "completedAt" ? late : "2026-08-25T00:00:02.000Z",
        requestedAt: field === "requestedAt" ? late : "2026-08-25T00:00:01.000Z",
      };
      expect(lateGreetingObservationV1Schema.safeParse({
        campaignId: "campaign-1", endedAt: "2026-08-25T00:21:01.000Z",
        greetingLedgerSha256: digest, kind: "late-greeting-negative-observation",
        lateAudiblePacketCount: 0, meetingId, method: "continuous-craig-opus-subscription",
        postRestartQuietMilliseconds: 60_000, restart, runId, schemaVersion: 1,
        settlementCompletedAt: settledAt, subscriptionStartedAt: "2026-08-24T23:59:00.000Z",
      }).success).toBe(false);
    },
  );

  it("rejects an over-limit join-to-first-audio interval", () => {
    const delayed = lifecycle();
    delayed.participantLifecycleReceipts[2]!.occurredAt = new Date(-1).toISOString();
    expect(() => buildGreetingLedgerQualification({
      campaignId: "campaign-1", campaignProof: campaignProof(),
      captures: OFFICIAL_GREETING_TEST_IDENTITIES.map(capture), ledgerRows: ledgerRows(),
      lifecycle: delayed, settlementObservedAt: settledAt,
    })).toThrow();
  });
});
