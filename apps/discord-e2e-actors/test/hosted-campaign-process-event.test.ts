import { describe, expect, it } from "vitest";

import {
  hostedCampaignProcessEventV1Schema,
  serializeHostedCampaignProcessEvent,
} from "../src/hosted-campaign-process-event.js";
import {
  publishAnswerIntent,
  publishCaptureRetained,
  publishObserverSubscribed,
} from "../src/hosted-campaign-process-event-publisher.js";

const runId = "run-reconnect";

describe("hosted campaign process event", () => {
  it("serializes a closed authenticated observer barrier as one NDJSON record", () => {
    const serialized = serializeHostedCampaignProcessEvent({
      event: {
        action: { kind: "observer-subscribed" },
        evidence: { authenticatedObserverBotId: "1533867700575670282" },
      },
      kind: "hosted-campaign-barrier",
      runId,
      schemaVersion: 1,
    });

    expect(serialized.endsWith("\n")).toBe(true);
    expect(hostedCampaignProcessEventV1Schema.parse(JSON.parse(serialized))).toEqual({
      event: {
        action: { kind: "observer-subscribed" },
        evidence: { authenticatedObserverBotId: "1533867700575670282" },
      },
      kind: "hosted-campaign-barrier",
      runId,
      schemaVersion: 1,
    });
  });

  it("accepts exact reconnect and answer correlations", () => {
    const events = [
      {
        event: {
          action: { kind: "reconnect-ready" as const },
          evidence: {
            observedAtEpochMilliseconds: 1_700_000_000_000,
            participantId: "1533228054724346087",
          },
        },
        kind: "hosted-campaign-barrier" as const,
        runId,
        schemaVersion: 1 as const,
      },
      {
        event: {
          action: { kind: "answer-observer-ready" as const },
          evidence: {
            observedAtEpochMilliseconds: 1_700_000_000_100,
            turnId: "turn-answer-1",
          },
        },
        kind: "hosted-campaign-barrier" as const,
        runId,
        schemaVersion: 1 as const,
      },
    ];

    expect(events.map((event) => hostedCampaignProcessEventV1Schema.parse(event)))
      .toHaveLength(2);
  });

  it("rejects mismatched capture ordinals and unknown evidence", () => {
    expect(() => hostedCampaignProcessEventV1Schema.parse({
      event: {
        action: { kind: "capture-retained", ordinal: 2 },
        evidence: { ordinal: 1, outputPath: "/tmp/capture.json", retained: true },
      },
      kind: "hosted-campaign-barrier",
      runId,
      schemaVersion: 1,
    })).toThrow(/ordinals must match/u);
    expect(() => hostedCampaignProcessEventV1Schema.parse({
      event: {
        action: { kind: "answer-intent" },
        evidence: {
          observedAtEpochMilliseconds: 1_700_000_000_000,
          turnId: "turn-1",
          invented: true,
        },
      },
      kind: "hosted-campaign-barrier",
      runId,
      schemaVersion: 1,
    })).toThrow();
  });

  it("publishes campaign-only NDJSON with exact retained and intent correlations", () => {
    const lines: string[] = [];
    const write = (value: string): void => {lines.push(value);};
    const config = { additionalCaptures: [{}], runId };
    publishObserverSubscribed(config, "1533867700575670282", write);
    publishAnswerIntent(config, {
      capturePlan: "addressed-answer", kind: "answer", meetingId: "meeting-1",
      playbackAttemptId: "attempt-1", protocolVersion: 1, runId,
      turnId: "turn-1", type: "playback-intent",
    }, "2026-08-12T17:00:00.000Z", write);
    publishCaptureRetained(config, 5, "/tmp/capture-5.json", write);

    const parsed = lines.map((line) => hostedCampaignProcessEventV1Schema.parse(JSON.parse(line)));
    expect(parsed.map(({ event }) => event.action.kind)).toEqual([
      "observer-subscribed", "answer-intent", "capture-retained",
    ]);
    expect(parsed.every((event) => event.runId === runId)).toBe(true);
  });

  it("does not publish hosted barriers outside the exact six-capture campaign", () => {
    const lines: string[] = [];
    const write = (value: string): void => {lines.push(value);};
    const config = { additionalCaptures: [], runId };
    publishObserverSubscribed(config, "1533867700575670282", write);
    publishCaptureRetained(config, 1, "/tmp/capture-1.json", write);
    expect(lines).toEqual([]);
  });
});
