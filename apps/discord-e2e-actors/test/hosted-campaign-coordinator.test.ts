import { describe, expect, it, vi } from "vitest";

import {
  HOSTED_CAMPAIGN_TARGET,
  runHostedCampaign,
  type HostedCampaignActionEvidence,
  type HostedCampaignBarrierAction,
  type HostedCampaignChildHandle,
  type HostedCampaignInput,
  type HostedCampaignLeaseHandle,
  type HostedCampaignPorts,
} from "../src/hosted-campaign-coordinator.js";

function input(): HostedCampaignInput {
  return {
    children: [child("observer"), child("speaker-a"), child("speaker-b")],
    target: HOSTED_CAMPAIGN_TARGET,
    thresholds: { answerFirstPacketMilliseconds: 4_000 },
    runs: [
      { ordinal: 1, scenario: "sequential", campaignId: "campaign-1", runId: "run-1", retainedCaptureCount: 0 },
      { ordinal: 2, scenario: "overlap", campaignId: "campaign-1", runId: "run-2", retainedCaptureCount: 0 },
      { ordinal: 3, scenario: "reconnect", campaignId: "campaign-1", runId: "run-3", retainedCaptureCount: 6 },
    ],
  };
}

function child(childId: string) {
  return { arguments: { kind: "environment" as const }, childId, entrypoint: "actor" as const, environment: {}, startBefore: "campaign" as const };
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
              ? { ordinal: action.ordinal, runId: action.runId, verified: true }
              : action.kind === "campaign-verified"
                ? { campaignId: "campaign-1" }
                : { digestSha256: "a".repeat(64) };
  return common as HostedCampaignActionEvidence<Action>;
}

function ports(events: string[]): HostedCampaignPorts {
  return {
    acquireCampaignLease: async (campaignId) => {
      events.push(`lease:${campaignId}`);
      return { campaignId } as HostedCampaignLeaseHandle;
    },
    publishReleaseGate: async (spec) => { events.push(`release-gate:${spec.childId}`); },
    awaitChildCompletion: async (_handle, spec) => { events.push(`complete:${spec.childId}`); },
    startChild: async (spec) => {
      events.push(`start:${spec.childId}`);
      return { childId: spec.childId } as HostedCampaignChildHandle;
    },
    awaitBarrier: async (action) => {
      events.push(`barrier:${action.kind}`);
      return evidence(action);
    },
    releaseCampaignLease: async (handle) => { events.push(`release:${handle.campaignId}`); },
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

    expect(events.slice(0, 4)).toEqual([
      "lease:campaign-1", "start:observer", "start:speaker-a", "start:speaker-b",
    ]);
    expect(events.slice(4, firstStop)).toEqual([
      "barrier:provenance-before",
      "barrier:observer-subscribed",
      "barrier:run-verified",
      "barrier:run-verified",
      "barrier:capture-retained",
      "barrier:capture-retained",
      "barrier:capture-retained",
      "barrier:capture-retained",
      "barrier:reconnect-left",
      "barrier:reconnect-ready",
      "barrier:answer-intent",
      "barrier:answer-observer-ready",
      "barrier:answer-first-packet",
      "barrier:capture-retained",
      "barrier:capture-retained",
      "barrier:run-verified",
      "barrier:provenance-after",
      "barrier:campaign-verified",
    ]);
    expect(events.slice(firstStop)).toEqual([
      "stop:observer", "stop:speaker-a", "stop:speaker-b", "release:campaign-1",
    ]);
    expect(receipt.actionEvidence.map((entry) => (entry as {
      readonly action: HostedCampaignBarrierAction;
    }).action)).toEqual([
      { kind: "provenance-before" },
      { kind: "observer-subscribed" },
      { kind: "run-verified", ordinal: 1, runId: "run-1" },
      { kind: "run-verified", ordinal: 2, runId: "run-2" },
      { kind: "capture-retained", ordinal: 1 },
      { kind: "capture-retained", ordinal: 2 },
      { kind: "capture-retained", ordinal: 3 },
      { kind: "capture-retained", ordinal: 4 },
      { kind: "reconnect-left" },
      { kind: "reconnect-ready" },
      { kind: "answer-intent" },
      { kind: "answer-observer-ready" },
      { kind: "answer-first-packet" },
      { kind: "capture-retained", ordinal: 5 },
      { kind: "capture-retained", ordinal: 6 },
      { kind: "run-verified", ordinal: 3, runId: "run-3" },
      { kind: "provenance-after" },
      { kind: "campaign-verified" },
    ]);
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

  it("uses the closed-plan answer threshold and verifies each run separately", async () => {
    const actions: HostedCampaignBarrierAction[] = [];
    const fakePorts = ports([]);
    fakePorts.awaitBarrier = async (action) => {
      actions.push(action);
      if (action.kind === "answer-first-packet") {
        return {
          answerLatencyMilliseconds: 4_001,
          observedAtEpochMilliseconds: 2,
          turnId: "turn-1",
        } as HostedCampaignActionEvidence<typeof action>;
      }
      return evidence(action);
    };
    const configured = { ...input(), thresholds: { answerFirstPacketMilliseconds: 4_001 } };

    await expect(runHostedCampaign(configured, fakePorts, bounded())).resolves.toMatchObject({
      runIds: ["run-1", "run-2", "run-3"],
    });
    expect(actions.filter((action) => action.kind === "run-verified")).toEqual([
      { kind: "run-verified", ordinal: 1, runId: "run-1" },
      { kind: "run-verified", ordinal: 2, runId: "run-2" },
      { kind: "run-verified", ordinal: 3, runId: "run-3" },
    ]);
  });

  it("stops a mismatched returned handle and releases the exclusive lease", async () => {
    const events: string[] = [];
    const fakePorts = ports(events);
    fakePorts.startChild = async () => ({ childId: "unexpected" }) as HostedCampaignChildHandle;

    await expect(runHostedCampaign(input(), fakePorts, bounded())).rejects.toThrow(/does not match/u);
    expect(events).toContain("stop:unexpected");
    expect(events.at(-1)).toBe("release:campaign-1");
  });

  it("rejects an invalid answer threshold before acquiring the lease", async () => {
    const events: string[] = [];
    const invalid = { ...input(), thresholds: { answerFirstPacketMilliseconds: Number.NaN } };
    await expect(runHostedCampaign(invalid, ports(events), bounded())).rejects.toThrow(/safe integer/u);
    expect(events).toEqual([]);
  });
});
