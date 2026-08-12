import { describe, expect, it } from "vitest";

import {
  HOSTED_CAMPAIGN_TARGET,
  validateHostedCampaign,
  type HostedCampaignActionReference,
  type HostedCampaignExecutableSpec,
  type HostedCampaignInput,
} from "../src/hosted-campaign-coordinator.js";
import { actionReferenceIdentity, campaignActions } from "../src/hosted-campaign-execution-graph.js";
import { parseHostedCampaignPlan } from "../src/hosted-campaign-run-config.js";

const runs = [
  { ordinal: 1, scenario: "sequential", campaignId: "campaign-1", runId: "run-1", retainedCaptureCount: 0 },
  { ordinal: 2, scenario: "overlap", campaignId: "campaign-1", runId: "run-2", retainedCaptureCount: 0 },
  { ordinal: 3, scenario: "reconnect", campaignId: "campaign-1", runId: "run-3", retainedCaptureCount: 6 },
] as const;

function skeleton(children: readonly HostedCampaignExecutableSpec[] = []): HostedCampaignInput {
  return { children, runs, target: HOSTED_CAMPAIGN_TARGET,
    thresholds: { answerFirstPacketMilliseconds: 4_000 } };
}

function finite(
  childId: string,
  kind: "actor-completed" | "conversation-observer-completed" | "playback-link-seen",
  completionAfter: HostedCampaignActionReference,
): HostedCampaignExecutableSpec {
  if (kind === "actor-completed") {
    const action = { kind, ordinal: 3, runId: "run-3" } as const;
    return { ...common(action), entrypoint: "actor", environment: {
      DISCORD_E2E_ACTOR_RUN_OUTPUT: `/evidence/${childId}.json`, DISCORD_E2E_RUN_ID: "run-3",
      DISCORD_E2E_SCENARIO: "reconnect",
    }, completion: { action, kind: "actor", outputPath: `/evidence/${childId}.json`, runId: "run-3",
      scenario: "reconnect" } };
  }
  if (kind === "conversation-observer-completed") {
    const action = { kind, ordinal: 3, runId: "run-3" } as const;
    return { ...common(action), entrypoint: "conversation-observer", environment: {
      DISCORD_E2E_CONVERSATION_VOICE_RUN_ID: "run-3",
    }, completion: { action, kind: "conversation-observer", outputPaths: [], runId: "run-3" } };
  }
  const action = { kind, ordinal: 3, runId: "run-3" } as const;
  return { ...common(action), entrypoint: "playback-link-observer", environment: {
    DISCORD_E2E_PLAYBACK_LINK_OUTPUT: `/evidence/${childId}.json`,
    DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID: "recording-1", DISCORD_E2E_PLAYBACK_LINK_RUN_ID: "run-3",
  }, completion: { action, kind: "playback-link-observer", outputPath: `/evidence/${childId}.json`,
    recordingId: "recording-1", runId: "run-3" } };

  function common<Action extends HostedCampaignExecutableSpec["produces"][number]["action"]>(completionAction: Action) {
    return {
      arguments: { kind: "environment" as const }, childId, completionAfter,
      produces: [{ action: completionAction, ordinal: 3, runId: "run-3", outputPath: `/evidence/${childId}-completed.json` }],
      requires: [], startBefore: { kind: "campaign" as const },
    };
  }
}

describe("hosted campaign completion scheduler", () => {
  it("recursively schedules stable finite completions after completion actions", () => {
    const base = campaignActions(skeleton());
    const trigger = base.find(({ action }) => action.kind === "answer-first-packet")!;
    const actor = finite("actor", "actor-completed", trigger);
    const actorCompletion = actor.produces[0]!;
    const observer = finite("observer", "conversation-observer-completed", actorCompletion);
    const observerCompletion = observer.produces[0]!;
    const playback = finite("playback", "playback-link-seen", observerCompletion);

    const actions = campaignActions(skeleton([actor, observer, playback]));
    const triggerIndex = actions.findIndex((reference) =>
      actionReferenceIdentity(reference) === actionReferenceIdentity(trigger));
    expect(actions.slice(triggerIndex + 1, triggerIndex + 4).map(({ action }) => action.kind)).toEqual([
      "actor-completed", "conversation-observer-completed", "playback-link-seen",
    ]);
  });

  it("allows a long-lived process to complete only after a late barrier", () => {
    const base = campaignActions(skeleton());
    const late = base.find(({ action }) => action.kind === "provenance-after")!;
    const actor = finite("late-actor", "actor-completed", late);
    const actions = campaignActions(skeleton([actor]));
    const lateIndex = actions.findIndex((reference) =>
      actionReferenceIdentity(reference) === actionReferenceIdentity(late));
    expect(actions[lateIndex + 1]?.action.kind).toBe("actor-completed");
  });

  it("accepts only the immediately prior verified run as an actor release gate", () => {
    const base = campaignActions(skeleton());
    const runOne = base.find(({ action }) => action.kind === "run-verified" && action.ordinal === 1)!;
    const actor = finite("run-two-actor", "actor-completed", runOne);
    const { completionAfter: _completionAfter, ...actorWithoutCompletionAfter } = actor;
    const runTwoAction = { kind: "actor-completed" as const, ordinal: 2, runId: "run-2" };
    const configured = { ...actorWithoutCompletionAfter,
      completion: { action: runTwoAction, kind: "actor" as const, outputPath: "/evidence/run-two-actor.json",
        runId: "run-2", scenario: "overlap" as const },
      environment: { ...actor.environment, DISCORD_E2E_ACTOR_RUN_OUTPUT: "/evidence/run-two-actor.json",
        DISCORD_E2E_HOSTED_RELEASE_GATE_ARMED_PATH: "/evidence/run-two.armed",
        DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: "/evidence/run-two.release", DISCORD_E2E_RUN_ID: "run-2",
        DISCORD_E2E_SCENARIO: "overlap" },
      produces: [{ action: runTwoAction, ordinal: 2, runId: "run-2",
        outputPath: "/evidence/run-two-actor-completed.json" }],
      releaseGate: { ...runOne, armedPath: "/evidence/run-two.armed", path: "/evidence/run-two.release" },
    } satisfies HostedCampaignExecutableSpec;
    const raw = skeleton([configured]);
    expect(parseHostedCampaignPlan(raw).children[0]?.releaseGate?.action.kind).toBe("run-verified");

    const runTwo = base.find(({ action }) => action.kind === "run-verified" && action.ordinal === 2)!;
    expect(() => validateHostedCampaign(skeleton([{ ...configured, releaseGate: {
      armedPath: "/evidence/wrong.armed",
      ...runTwo, path: "/evidence/run-two.release",
    } }]))).toThrow(/prior verified run/u);
  });

  it("fails closed for missing triggers, cycles and duplicate schedules", () => {
    const missing = { action: { kind: "recording-ready" as const, ordinal: 1, runId: "missing" },
      ordinal: 1, runId: "missing" };
    expect(() => campaignActions(skeleton([finite("missing", "actor-completed", missing)])))
      .toThrow(/unknown action/u);

    const placeholder = { action: { kind: "actor-completed" as const, ordinal: 3, runId: "run-3" },
      ordinal: 3, runId: "run-3" };
    const first = finite("first", "actor-completed", placeholder);
    const second = finite("second", "conversation-observer-completed", first.produces[0]!);
    const cycle = { ...first, completionAfter: second.produces[0]! };
    expect(() => campaignActions(skeleton([cycle, second]))).toThrow(/cycle/u);

    const base = campaignActions(skeleton());
    const trigger = base[0]!;
    expect(() => campaignActions(skeleton([
      finite("duplicate-a", "actor-completed", trigger),
      finite("duplicate-b", "actor-completed", trigger),
    ]))).toThrow(/multiple schedules/u);
  });

  it("accepts only a strict action reference in serialized completionAfter", () => {
    const base = campaignActions(skeleton());
    const trigger = base[0]!;
    const child = finite("serialized", "actor-completed", trigger);
    const raw = skeleton([child]);
    expect(parseHostedCampaignPlan(raw).children[0]?.completionAfter).toEqual(trigger);
    expect(() => parseHostedCampaignPlan({ ...raw, children: [{ ...child,
      completionAfter: { ...trigger, unexpected: true } }] })).toThrow();
  });
});
