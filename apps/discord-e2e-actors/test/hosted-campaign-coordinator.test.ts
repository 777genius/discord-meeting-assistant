import { describe, expect, it, vi } from "vitest";

import {
  HOSTED_CAMPAIGN_TARGET,
  runHostedCampaign,
  type HostedCampaignActionEvidence,
  type HostedCampaignBarrierAction,
  type HostedCampaignChildHandle,
  type HostedCampaignInput,
  type HostedCampaignPorts,
} from "../src/hosted-campaign-coordinator.js";

function input(): HostedCampaignInput {
  return {
    children: [child("observer"), child("speaker-a"), child("speaker-b")],
    target: HOSTED_CAMPAIGN_TARGET,
    runs: [
      { ordinal: 1, scenario: "sequential", campaignId: "campaign-1", runId: "run-1", retainedCaptureCount: 0 },
      { ordinal: 2, scenario: "overlap", campaignId: "campaign-1", runId: "run-2", retainedCaptureCount: 0 },
      { ordinal: 3, scenario: "reconnect", campaignId: "campaign-1", runId: "run-3", retainedCaptureCount: 6 },
    ],
  };
}

function child(childId: string) {
  return { arguments: [], childId, entrypoint: "actor" as const, environment: {} };
}

function evidence<Action extends HostedCampaignBarrierAction>(action: Action): HostedCampaignActionEvidence<Action> {
  const common = action.kind === "capture-retained"
    ? { ordinal: action.ordinal, outputPath: `/evidence/${action.ordinal}.json`, retained: true }
    : action.kind === "answer-first-packet"
      ? { answerLatencyMilliseconds: 4_000, observedAtEpochMilliseconds: 2, turnId: "turn-1" }
      : action.kind === "answer-intent" || action.kind === "answer-observer-ready"
        ? { observedAtEpochMilliseconds: 1, turnId: "turn-1" }
        : action.kind === "observer-subscribed"
          ? { authenticatedObserverBotId: HOSTED_CAMPAIGN_TARGET.observerApplicationId }
          : action.kind === "reconnect-left" || action.kind === "reconnect-ready"
            ? { observedAtEpochMilliseconds: 1, participantId: HOSTED_CAMPAIGN_TARGET.speakerBApplicationId }
            : action.kind === "run-verified"
              ? { runIds: ["run-1", "run-2", "run-3"] }
              : action.kind === "campaign-verified"
                ? { campaignId: "campaign-1" }
                : { digestSha256: "a".repeat(64) };
  return common as HostedCampaignActionEvidence<Action>;
}

function ports(events: string[]): HostedCampaignPorts {
  return {
    startChild: async (spec) => {
      events.push(`start:${spec.childId}`);
      return { childId: spec.childId } as HostedCampaignChildHandle;
    },
    awaitBarrier: async (action) => {
      events.push(`barrier:${action.kind}`);
      return evidence(action);
    },
    stopChild: async (handle) => { events.push(`stop:${handle.childId}`); },
  };
}

const bounded = () => ({ deadlineEpochMilliseconds: Date.now() + 60_000, signal: new AbortController().signal });

describe("hosted campaign coordinator", () => {
  it("preflights the complete plan before starting any child", async () => {
    const events: string[] = [];
    const invalid = { ...input(), target: { ...HOSTED_CAMPAIGN_TARGET, guildId: "wrong" } } as unknown as HostedCampaignInput;
    await expect(runHostedCampaign(invalid, ports(events), bounded())).rejects.toThrow(/guildId/u);
    expect(events).toEqual([]);
  });

  it("keeps long-lived observer and actors alive across every barrier, then stops all", async () => {
    const events: string[] = [];
    const receipt = await runHostedCampaign(input(), ports(events), bounded());
    const firstStop = events.findIndex((event) => event.startsWith("stop:"));

    expect(events.slice(0, 3)).toEqual(["start:observer", "start:speaker-a", "start:speaker-b"]);
    expect(events.slice(3, firstStop)).toHaveLength(16);
    expect(events.slice(firstStop)).toEqual(["stop:observer", "stop:speaker-a", "stop:speaker-b"]);
    expect(receipt).toMatchObject({ schemaVersion: 1, campaignId: "campaign-1", teardownComplete: true });
  });

  it("honours cancellation before the first child and during barriers", async () => {
    const beforeStart = new AbortController();
    beforeStart.abort(new Error("cancelled"));
    const noEvents: string[] = [];
    await expect(runHostedCampaign(input(), ports(noEvents), {
      deadlineEpochMilliseconds: Date.now() + 60_000, signal: beforeStart.signal,
    })).rejects.toThrow("cancelled");
    expect(noEvents).toEqual([]);

    const controller = new AbortController();
    const events: string[] = [];
    const fakePorts = ports(events);
    const barrier = fakePorts.awaitBarrier;
    fakePorts.awaitBarrier = async (action, bound) => {
      const result = await barrier(action, bound);
      controller.abort(new Error("campaign cancelled"));
      return result;
    };
    await expect(runHostedCampaign(input(), fakePorts, {
      deadlineEpochMilliseconds: Date.now() + 60_000, signal: controller.signal,
    })).rejects.toThrow("campaign cancelled");
    expect(events.filter((event) => event.startsWith("stop:"))).toHaveLength(3);
  });

  it("rejects latency above 4000ms and attempts every child cleanup", async () => {
    const events: string[] = [];
    const fakePorts = ports(events);
    fakePorts.awaitBarrier = async (action) => action.kind === "answer-first-packet"
      ? { answerLatencyMilliseconds: 4_001, observedAtEpochMilliseconds: 2, turnId: "turn-1" } as HostedCampaignActionEvidence<typeof action>
      : evidence(action);
    fakePorts.stopChild = vi.fn(async (handle) => { events.push(`stop:${handle.childId}`); });

    await expect(runHostedCampaign(input(), fakePorts, bounded())).rejects.toThrow(/SLA failed/u);
    expect(fakePorts.stopChild).toHaveBeenCalledTimes(3);
  });
});
