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
import { campaignActions } from "../src/hosted-campaign-execution-graph.js";

function input(): HostedCampaignInput {
  const runs = [
    { ordinal: 1, scenario: "sequential", campaignId: "campaign-1", runId: "run-1", retainedCaptureCount: 0 },
    { ordinal: 2, scenario: "overlap", campaignId: "campaign-1", runId: "run-2", retainedCaptureCount: 0 },
    { ordinal: 3, scenario: "reconnect", campaignId: "campaign-1", runId: "run-3", retainedCaptureCount: 6 },
  ] as const;
  const skeleton = { children: [], target: HOSTED_CAMPAIGN_TARGET,
    thresholds: { answerFirstPacketMilliseconds: 4_000 }, runs };
  const actions = campaignActions(skeleton);
  const production = (kind: HostedCampaignBarrierAction["kind"]) => actions
    .filter(({ action }) => action.kind === kind)
    .map((reference, index) => ({
      ...reference, outputPath: `/evidence/${kind}-${index}.json`,
    }));
  return {
    ...skeleton,
    children: [
      executable("conversation-observer", "conversation-observer", [
        ...production("observer-subscribed"), ...production("capture-retained"),
        ...production("answer-intent"), ...production("answer-observer-ready"),
        ...production("answer-first-packet"),
      ]),
      executable("reconnect-actor", "actor", [
        ...production("reconnect-left"), ...production("reconnect-ready"),
      ]),
      provenanceProducer("before", production("provenance-before")[0]!),
      ...production("run-verified").map((produced, index) => verificationProducer(index + 1, produced)),
      serviceLevelsProducer(production("service-levels-ready")[0]!),
      provenanceProducer("after", production("provenance-after")[0]!),
      campaignVerificationProducer(production("campaign-verified")[0]!),
    ],
    target: HOSTED_CAMPAIGN_TARGET,
    thresholds: { answerFirstPacketMilliseconds: 4_000 },
  };
}

function verificationProducer(
  ordinal: number,
  produced: HostedCampaignInput["children"][number]["produces"][number],
) {
  const action = produced.action as Extract<HostedCampaignBarrierAction, { readonly kind: "run-verified" }>;
  return {
    arguments: { evidencePath: `/evidence/run-${ordinal}.json`, kind: "evidence-verifier" as const,
      manifestPath: "/evidence/manifest.json" },
    childId: `verifier-${ordinal}`, completion: { action, kind: "evidence-verifier" as const },
    entrypoint: "evidence-verifier" as const, environment: {}, produces: [produced], requires: [],
    startBefore: { action, kind: "barrier" as const, ordinal: produced.ordinal, runId: produced.runId },
  };
}

function provenanceProducer(
  phase: "after" | "before",
  produced: HostedCampaignInput["children"][number]["produces"][number],
) {
  const action = produced.action as Extract<HostedCampaignBarrierAction, {
    readonly kind: "provenance-after" | "provenance-before";
  }>;
  return {
    arguments: { kind: "environment" as const }, childId: `provenance-${phase}`,
    completion: { action, campaignId: "campaign-1", kind: "provenance-probe" as const, phase,
      runIds: ["run-1", "run-2", "run-3"] as const, snapshotPath: "/evidence/provenance.json" },
    entrypoint: "provenance-probe" as const, environment: {
      DISCORD_E2E_PROVENANCE_CAMPAIGN_ID: "campaign-1", DISCORD_E2E_PROVENANCE_PHASE: phase,
      DISCORD_E2E_PROVENANCE_RUN_IDS_JSON: '["run-1","run-2","run-3"]',
      DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH: "/evidence/provenance.json",
    }, produces: [produced], requires: [],
    startBefore: { action, kind: "barrier" as const, ordinal: produced.ordinal, runId: produced.runId },
  };
}

function serviceLevelsProducer(
  produced: HostedCampaignInput["children"][number]["produces"][number],
) {
  const action = produced.action as Extract<HostedCampaignBarrierAction, { readonly kind: "service-levels-ready" }>;
  return {
    arguments: { kind: "environment" as const }, childId: "service-levels",
    completion: { action, campaignId: "campaign-1", kind: "service-levels" as const,
      meetingId: "meeting-1", outputPath: "/evidence/service-levels.json",
      recordingId: "recording-1", reportPath: "/evidence/service-levels-report.json", runId: "run-3" },
    entrypoint: "service-levels" as const, environment: {
      DISCORD_E2E_SLA_CAMPAIGN_ID: "campaign-1", DISCORD_E2E_SLA_MEETING_ID: "meeting-1",
      DISCORD_E2E_SLA_OUTPUT: "/evidence/service-levels.json", DISCORD_E2E_SLA_RECORDING_ID: "recording-1",
      DISCORD_E2E_SLA_REPORT_OUTPUT: "/evidence/service-levels-report.json", DISCORD_E2E_SLA_RUN_ID: "run-3",
    }, produces: [produced], requires: [],
    startBefore: { action, kind: "barrier" as const, ordinal: produced.ordinal, runId: produced.runId },
  };
}

function campaignVerificationProducer(
  produced: HostedCampaignInput["children"][number]["produces"][number],
) {
  const action = produced.action as Extract<HostedCampaignBarrierAction, { readonly kind: "campaign-verified" }>;
  return {
    arguments: { evidencePaths: ["/evidence/1.json", "/evidence/2.json", "/evidence/3.json"] as const,
      kind: "campaign-verifier" as const, manifestPath: "/evidence/manifest.json" },
    childId: "campaign-verifier", completion: { action, campaignId: "campaign-1",
      kind: "campaign-verifier" as const, runIds: ["run-1", "run-2", "run-3"] as const },
    entrypoint: "campaign-verifier" as const, environment: {}, produces: [produced], requires: [],
    startBefore: { action, kind: "barrier" as const, ordinal: produced.ordinal, runId: produced.runId },
  };
}

function executable(
  childId: string,
  entrypoint: HostedCampaignInput["children"][number]["entrypoint"],
  produces: HostedCampaignInput["children"][number]["produces"],
) {
  return { arguments: { kind: "environment" as const }, childId, entrypoint, environment: {},
    produces, requires: [], startBefore: { kind: "campaign" as const } };
}

function child(childId: string, produces: HostedCampaignInput["children"][number]["produces"] = []) {
  return { arguments: { kind: "environment" as const }, childId, entrypoint: "actor" as const, environment: {},
    produces, requires: [], startBefore: { kind: "campaign" as const } };
}

function oneShotChild(
  childId: string,
  action: Extract<HostedCampaignBarrierAction, { readonly kind: "capture-retained" | "run-verified" }>,
) {
  const reference = action.kind === "run-verified"
    ? { action, ordinal: action.ordinal, runId: action.runId }
    : { action, ordinal: 3, runId: "run-3" };
  return {
    arguments: action.kind === "run-verified"
      ? { evidencePath: "/evidence.json", kind: "evidence-verifier" as const, manifestPath: "/manifest.json" }
      : { kind: "environment" as const },
    childId,
    ...(action.kind === "run-verified" ? {
      completion: { action, kind: "evidence-verifier" as const },
    } : {}),
    entrypoint: action.kind === "run-verified" ? "evidence-verifier" as const : "live-observer" as const,
    environment: {},
    produces: action.kind === "run-verified" ? [{ ...reference, outputPath: `/evidence/${childId}.json` }] : [],
    requires: [],
    startBefore: { ...reference, kind: "barrier" as const },
  };
}

function evidence<Action extends HostedCampaignBarrierAction>(action: Action): HostedCampaignActionEvidence<Action> {
  const common = action.kind === "capture-retained"
    ? { ordinal: action.ordinal, outputPath: `/evidence/${action.ordinal}.json`, retained: true }
    : action.kind === "answer-first-packet"
      ? { answerLatencyMilliseconds: 4_000, observedAtEpochMilliseconds: 2, turnId: "turn-1" }
      : action.kind === "service-levels-ready"
        ? { measurementCount: 3, outputPath: "/evidence/service-levels.json", recordingId: "meeting-1", runId: "run-3" }
      : action.kind === "answer-intent" || action.kind === "answer-observer-ready"
        ? { observedAtEpochMilliseconds: 1, turnId: "turn-1" }
        : action.kind === "observer-subscribed"
          ? { authenticatedObserverBotId: HOSTED_CAMPAIGN_TARGET.observerApplicationId }
          : action.kind === "reconnect-left" || action.kind === "reconnect-ready"
            ? { observedAtEpochMilliseconds: 1, participantId: HOSTED_CAMPAIGN_TARGET.speakerBApplicationId }
            : action.kind === "run-verified"
              ? { ordinal: action.ordinal, runId: action.runId, verified: true }
              : action.kind === "recording-ready"
                ? { completed: true, meetingId: "recording-1", ordinal: action.ordinal,
                  recordingId: "recording-1", runId: action.runId }
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
    publishSupplementalGate: async (spec, phase) => { events.push(`supplemental-gate:${spec.childId}:${phase}`); },
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
  it("injects closed recording-ready identity bindings only after validated source evidence", async () => {
    const base = input();
    const provenance = campaignActions(base)[0]!;
    const observerSubscribed = campaignActions(base).find(({ action }) =>
      action.kind === "observer-subscribed"
    )!;
    const readyAction = { kind: "recording-ready" as const, ordinal: 1, runId: "run-1" };
    const readyReference = { action: readyAction, ordinal: 1, runId: "run-1" };
    const ready = {
      arguments: { kind: "environment" as const }, childId: "recording-ready", entrypoint: "recording-ready" as const,
      environment: { DISCORD_E2E_READY_RECEIPT_OUTPUT: "/evidence/recording-ready.json",
        DISCORD_E2E_RUN_ID: "run-1" },
      completion: { action: readyAction, kind: "recording-ready" as const,
        outputPath: "/evidence/recording-ready.json", runId: "run-1" },
      produces: [{ ...readyReference, outputPath: "/evidence/recording-ready-completed.json" }],
      requires: [], startBefore: { ...provenance, kind: "barrier" as const },
    };
    const consumer = {
      ...child("bound-consumer"),
      environmentBindings: [{ name: "DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID" as const,
        valueFrom: { actionRef: readyReference, field: "recordingId" as const } }],
      requires: [readyReference], startBefore: { ...observerSubscribed, kind: "barrier" as const },
    };
    const configured = { ...base, children: [...base.children, ready, consumer] };
    const observed: string[] = [];
    const fakePorts = ports([]);
    fakePorts.startChild = async (spec) => {
      if (spec.childId === "bound-consumer") {
        observed.push(spec.environment.DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID ?? "missing");
      }
      return { childId: spec.childId } as HostedCampaignChildHandle;
    };
    await expect(runHostedCampaign(configured, fakePorts, bounded())).resolves.toBeDefined();
    expect(observed).toEqual(["recording-1"]);
  });

  it("rejects wrong-source, wrong-field and out-of-order environment bindings", async () => {
    const base = input();
    const first = campaignActions(base)[0]!;
    const second = campaignActions(base)[1]!;
    const wrongSource = { ...child("wrong-source"), environmentBindings: [{
      name: "DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID" as const,
      valueFrom: { actionRef: first, field: "recordingId" as const },
    }], requires: [first], startBefore: { ...second, kind: "barrier" as const } };
    await expect(runHostedCampaign({ ...base, children: [...base.children, wrongSource] }, ports([]), bounded()))
      .rejects.toThrow(/source must be recording-ready/u);
  });

  it("rejects bound evidence with a missing or non-string identity", async () => {
    const base = input();
    const provenance = campaignActions(base)[0]!;
    const observerSubscribed = campaignActions(base).find(({ action }) =>
      action.kind === "observer-subscribed"
    )!;
    const action = { kind: "recording-ready" as const, ordinal: 1, runId: "run-1" };
    const source = { action, ordinal: 1, runId: "run-1" };
    const ready = {
      arguments: { kind: "environment" as const }, childId: "recording-ready-bad", entrypoint: "recording-ready" as const,
      environment: { DISCORD_E2E_READY_RECEIPT_OUTPUT: "/evidence/ready-bad.json", DISCORD_E2E_RUN_ID: "run-1" },
      completion: { action, kind: "recording-ready" as const, outputPath: "/evidence/ready-bad.json", runId: "run-1" },
      produces: [{ ...source, outputPath: "/evidence/ready-bad-completed.json" }], requires: [],
      startBefore: { ...provenance, kind: "barrier" as const },
    };
    const consumer = { ...child("bad-bound-consumer"), environmentBindings: [{
      name: "DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID" as const,
      valueFrom: { actionRef: source, field: "recordingId" as const },
    }], requires: [source], startBefore: { ...observerSubscribed, kind: "barrier" as const } };
    const fakePorts = ports([]);
    const original = fakePorts.awaitBarrier.bind(fakePorts);
    fakePorts.awaitBarrier = async (barrier, bound) => barrier.kind === "recording-ready"
      ? { completed: true, meetingId: "recording-1", ordinal: 1, recordingId: 42, runId: "run-1" } as never
      : original(barrier, bound);
    await expect(runHostedCampaign({ ...base, children: [...base.children, ready, consumer] }, fakePorts, bounded()))
      .rejects.toThrow(/identity evidence is invalid|bound recordingId is invalid/u);
  });

  it("releases a finite actor before awaiting its run-scoped completion", async () => {
    const base = input();
    const completionAction = { kind: "actor-completed" as const, ordinal: 1, runId: "run-1" };
    const provenance = campaignActions(base)[0]!;
    const actor = {
      arguments: { kind: "environment" as const }, childId: "finite-actor", entrypoint: "actor" as const,
      environment: {
        DISCORD_E2E_ACTOR_RUN_OUTPUT: "/evidence/actor.json",
        DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: "/evidence/release.json",
        DISCORD_E2E_RUN_ID: "run-1", DISCORD_E2E_SCENARIO: "sequential",
      },
      completion: { action: completionAction, kind: "actor" as const, outputPath: "/evidence/actor.json",
        runId: "run-1", scenario: "sequential" as const },
      produces: [{ action: completionAction, ordinal: 1, runId: "run-1", outputPath: "/evidence/actor-completed.json" }],
      requires: [], startBefore: { kind: "campaign" as const },
      releaseGate: { action: provenance.action, ordinal: provenance.ordinal, path: "/evidence/release.json",
        runId: provenance.runId },
    };
    const configured = { ...base, children: [...base.children, actor] };
    const events: string[] = [];
    let released = false;
    let completed = false;
    const fakePorts = ports(events);
    fakePorts.publishReleaseGate = async () => { released = true; events.push("release-gate:finite-actor"); };
    fakePorts.awaitChildCompletion = async (_handle, spec) => {
      if (spec.childId !== "finite-actor") {return;}
      await vi.waitUntil(() => released);
      completed = true;
      events.push("complete:finite-actor");
    };
    const originalBarrier = fakePorts.awaitBarrier.bind(fakePorts);
    fakePorts.awaitBarrier = async (action, bound) => {
      if (action.kind === "actor-completed") {
        await vi.waitUntil(() => completed);
        return { completed: true, ordinal: action.ordinal, runId: action.runId } as HostedCampaignActionEvidence<typeof action>;
      }
      return originalBarrier(action, bound);
    };

    await expect(runHostedCampaign(configured, fakePorts, bounded())).resolves.toMatchObject({ campaignId: "campaign-1" });
    expect(events.indexOf("release-gate:finite-actor")).toBeLessThan(events.indexOf("complete:finite-actor"));
    expect(events).toContain("barrier:provenance-before");
  });

  it("cancels a losing owned barrier poll and preserves the child failure through exact-once cleanup", async () => {
    const base = input();
    const action = { kind: "actor-completed" as const, ordinal: 1, runId: "run-1" };
    const provenance = campaignActions(base)[0]!;
    const actor = {
      arguments: { kind: "environment" as const }, childId: "failing-actor", entrypoint: "actor" as const,
      environment: { DISCORD_E2E_ACTOR_RUN_OUTPUT: "/evidence/actor.json",
        DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: "/evidence/release.json", DISCORD_E2E_RUN_ID: "run-1",
        DISCORD_E2E_SCENARIO: "sequential" },
      completion: { action, kind: "actor" as const, outputPath: "/evidence/actor.json", runId: "run-1",
        scenario: "sequential" as const },
      produces: [{ action, ordinal: 1, runId: "run-1", outputPath: "/evidence/actor-completed.json" }],
      requires: [], startBefore: { kind: "campaign" as const },
      releaseGate: { action: provenance.action, ordinal: provenance.ordinal, path: "/evidence/release.json",
        runId: provenance.runId },
    };
    const events: string[] = [];
    const primaryFailure = new Error("actor exploded");
    const cancellationFailure = new Error("owned barrier poll cancelled");
    const campaignCancellation = new AbortController();
    const ownedPolls = new Set<AbortSignal>();
    const ownedHandles = new Set<string>();
    const stopCounts = new Map<string, number>();
    let releaseCount = 0;
    let markBarrierStarted: (() => void) | undefined;
    const barrierStarted = new Promise<void>((resolve) => { markBarrierStarted = resolve; });
    const fakePorts = ports(events);
    const startChild = fakePorts.startChild.bind(fakePorts);
    fakePorts.startChild = async (spec, bound) => {
      const handle = await startChild(spec, bound);
      ownedHandles.add(handle.childId);
      return handle;
    };
    fakePorts.awaitChildCompletion = async (_handle, spec) => {
      if (spec.childId === "failing-actor") {
        await barrierStarted;
        throw primaryFailure;
      }
    };
    const originalBarrier = fakePorts.awaitBarrier.bind(fakePorts);
    fakePorts.awaitBarrier = async (barrierAction, bound) => {
      if (barrierAction.kind === "provenance-before") {
        expect(bound.signal).not.toBe(campaignCancellation.signal);
        ownedPolls.add(bound.signal);
        markBarrierStarted?.();
        return new Promise((_resolve, reject) => {
          const cancel = () => {
            ownedPolls.delete(bound.signal);
            reject(cancellationFailure);
          };
          if (bound.signal.aborted) { cancel(); }
          else { bound.signal.addEventListener("abort", cancel, { once: true }); }
        });
      }
      return originalBarrier(barrierAction, bound);
    };
    fakePorts.stopChild = async (handle) => {
      stopCounts.set(handle.childId, (stopCounts.get(handle.childId) ?? 0) + 1);
      ownedHandles.delete(handle.childId);
      events.push(`stop:${handle.childId}`);
    };
    fakePorts.releaseCampaignLease = async (handle) => {
      releaseCount += 1;
      events.push(`release:${handle.campaignId}`);
    };

    await expect(runHostedCampaign({ ...base, children: [...base.children, actor] }, fakePorts, {
      deadlineEpochMilliseconds: Date.now() + 60_000,
      signal: campaignCancellation.signal,
    })).rejects.toBe(primaryFailure);
    expect(ownedPolls.size).toBe(0);
    expect(ownedHandles.size).toBe(0);
    expect([...stopCounts.values()].every((count) => count === 1)).toBe(true);
    expect(releaseCount).toBe(1);
    expect(campaignCancellation.signal.aborted).toBe(false);
    expect(events.filter((event) => event.startsWith("stop:"))).toHaveLength(4);
    expect(events.at(-1)).toBe("release:campaign-1");
  });

  it("bounds teardown when a losing barrier poll ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const base = input();
      const action = { kind: "actor-completed" as const, ordinal: 1, runId: "run-1" };
      const provenance = campaignActions(base)[0]!;
      const actor = {
        arguments: { kind: "environment" as const }, childId: "failing-actor", entrypoint: "actor" as const,
        environment: { DISCORD_E2E_ACTOR_RUN_OUTPUT: "/evidence/actor.json",
          DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: "/evidence/release.json", DISCORD_E2E_RUN_ID: "run-1",
          DISCORD_E2E_SCENARIO: "sequential" },
        completion: { action, kind: "actor" as const, outputPath: "/evidence/actor.json", runId: "run-1",
          scenario: "sequential" as const },
        produces: [{ action, ordinal: 1, runId: "run-1", outputPath: "/evidence/actor-completed.json" }],
        requires: [], startBefore: { kind: "campaign" as const },
        releaseGate: { action: provenance.action, ordinal: provenance.ordinal, path: "/evidence/release.json",
          runId: provenance.runId },
      };
      const events: string[] = [];
      const primaryFailure = new Error("actor exploded");
      let markBarrierStarted: (() => void) | undefined;
      const barrierStarted = new Promise<void>((resolve) => { markBarrierStarted = resolve; });
      const fakePorts = ports(events);
      fakePorts.awaitChildCompletion = async (_handle, spec) => {
        if (spec.childId === "failing-actor") {
          await barrierStarted;
          throw primaryFailure;
        }
      };
      const originalBarrier = fakePorts.awaitBarrier.bind(fakePorts);
      fakePorts.awaitBarrier = async (barrierAction, bound) => {
        if (barrierAction.kind === "provenance-before") {
          markBarrierStarted?.();
          expect(bound.signal.aborted).toBe(false);
          return new Promise<never>(() => {});
        }
        return originalBarrier(barrierAction, bound);
      };

      const campaignFailure = runHostedCampaign(
        { ...base, children: [...base.children, actor] }, fakePorts, bounded(),
      ).catch((error: unknown) => error);
      await barrierStarted;
      await vi.advanceTimersByTimeAsync(249);
      expect(events.some((event) => event.startsWith("stop:"))).toBe(false);
      expect(events).not.toContain("release:campaign-1");
      await vi.advanceTimersByTimeAsync(1);
      const failure = await campaignFailure;
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).cause).toBe(primaryFailure);
      expect(events.filter((event) => event.startsWith("stop:"))).toHaveLength(4);
      expect(events).not.toContain("release:campaign-1");
      expect(events.at(-1)?.startsWith("stop:")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

});

describe("hosted campaign retained evidence finalization", () => {
  it("retains the campaign lease when create-only evidence publication fails", async () => {
    const events: string[] = [];
    const fakePorts = ports(events);
    await expect(runHostedCampaign(input(), fakePorts, bounded(), {
      authorizeAfterLease: async () => ({ assertReadyForFirstChild: () => {} }),
      finalizeUnderLease: async () => { throw new Error("evidence publication failed"); },
      retainLeaseOnFailure: () => true,
    })).rejects.toThrow("evidence publication failed");
    expect(events.some((event) => event.startsWith("stop:"))).toBe(true);
    expect(events).not.toContain("release:campaign-1");
  });

  it("publishes final cleanup evidence only after exact lease deletion succeeds", async () => {
    const events: string[] = [];
    const fakePorts = ports(events);
    const lease = { campaignId: "campaign-1", campaignRoot: "/private/campaign-1", device: 7, inode: 8,
      leaseSha256: "a".repeat(64), planSha256: "b".repeat(64) } as HostedCampaignLeaseHandle;
    fakePorts.acquireCampaignLease = async () => lease;
    fakePorts.releaseCampaignLease = async () => {
      events.push("lease-deleted");
      return { campaignId: lease.campaignId, campaignRoot: lease.campaignRoot, deleted: true,
        device: lease.device, inode: lease.inode, leasePath: `${lease.campaignRoot}/barriers/campaign.lease`,
        leaseSha256: lease.leaseSha256, planSha256: lease.planSha256 };
    };
    await runHostedCampaign(input(), fakePorts, bounded(), {
      authorizeAfterLease: async () => ({ assertReadyForFirstChild: () => {} }),
      finalizeAfterLeaseCleanup: async (cleanup) => { events.push(`cleanup:${cleanup.deleted}`); },
    });
    expect(events.slice(-2)).toEqual(["lease-deleted", "cleanup:true"]);
  });
});

describe("hosted campaign coordinator lifecycle", () => {
  it("binds every action and observer dependency to the exact causal run", () => {
    const references = campaignActions(input());
    expect(references.filter(({ action }) => action.kind === "run-verified")).toEqual([
      { action: { kind: "run-verified", ordinal: 1, runId: "run-1" }, ordinal: 1, runId: "run-1" },
      { action: { kind: "run-verified", ordinal: 2, runId: "run-2" }, ordinal: 2, runId: "run-2" },
      { action: { kind: "run-verified", ordinal: 3, runId: "run-3" }, ordinal: 3, runId: "run-3" },
    ]);
    expect(references.filter(({ action }) => action.kind === "observer-subscribed")).toEqual([
      { action: { kind: "observer-subscribed" }, ordinal: 3, runId: "run-3" },
    ]);
    expect(references.filter(({ action }) => action.kind === "reconnect-ready")).toEqual([
      { action: { kind: "reconnect-ready" }, ordinal: 3, runId: "run-3" },
    ]);
    expect(references.filter(({ action }) => action.kind === "service-levels-ready")).toEqual([
      { action: { kind: "service-levels-ready" }, ordinal: 3, runId: "run-3" },
    ]);
  });

  it("fails closed for missing and duplicate action producers", async () => {
    const base = input();
    const producer = base.children.find(({ produces }) => produces.length > 0)!;
    const missing = { ...base, children: base.children.map((candidate) => candidate === producer
      ? { ...producer, produces: producer.produces.slice(1) } : candidate) };
    await expect(runHostedCampaign(missing, ports([]), bounded())).rejects.toThrow(/has no producer/u);

    const duplicate = { ...base, children: [...base.children, {
      ...producer, childId: "duplicate",
    }] };
    await expect(runHostedCampaign(duplicate, ports([]), bounded())).rejects.toThrow(/multiple producers/u);
  });

  it("fails closed for output path collisions and dependency cycles", async () => {
    const base = input();
    const observer = base.children.find(({ childId }) => childId === "conversation-observer")!;
    const collisionProduction = { ...observer.produces[1]!, outputPath: observer.produces[0]!.outputPath };
    const collision = { ...base, children: base.children.map((candidate) => candidate === observer ? {
      ...observer, produces: [observer.produces[0]!, collisionProduction, ...observer.produces.slice(2)],
    } : candidate) };
    await expect(runHostedCampaign(collision, ports([]), bounded())).rejects.toThrow(/path collision/u);

    const first = observer.produces[0]!;
    const second = observer.produces[1]!;
    const cyclic = { ...base, children: [
      { ...observer, produces: observer.produces.slice(2) },
      { ...executable("producer-a", "conversation-observer", [first]), requires: [second],
        startBefore: { ...second, kind: "barrier" as const } },
      { ...executable("producer-b", "conversation-observer", [second]), requires: [first],
        startBefore: { ...first, kind: "barrier" as const } },
      ...base.children.slice(1),
    ] };
    await expect(runHostedCampaign(cyclic, ports([]), bounded())).rejects.toThrow(/requirement must precede|cycle/u);
  });

  it("preflights the complete plan before starting any child", async () => {
    const events: string[] = [];
    const invalid = { ...input(), target: { ...HOSTED_CAMPAIGN_TARGET, guildId: "wrong" } } as unknown as HostedCampaignInput;
    await expect(runHostedCampaign(invalid, ports(events), bounded())).rejects.toThrow(/guildId/u);
    expect(events).toEqual([]);
  });

  it("keeps long-lived observer and actors alive across every barrier, then stops all", async () => {
    const events: string[] = [];
    const campaignCancellation = new AbortController();
    const ownedPolls = new Set<AbortSignal>();
    const pollSignals = new Set<AbortSignal>();
    let pollCleanupCount = 0;
    const fakePorts = ports(events);
    const awaitBarrier = fakePorts.awaitBarrier.bind(fakePorts);
    fakePorts.awaitBarrier = async (action, bound) => {
      expect(bound.signal).not.toBe(campaignCancellation.signal);
      ownedPolls.add(bound.signal);
      pollSignals.add(bound.signal);
      bound.signal.addEventListener("abort", () => {
        pollCleanupCount += 1;
        ownedPolls.delete(bound.signal);
      }, { once: true });
      return awaitBarrier(action, bound);
    };
    const receipt = await runHostedCampaign(input(), fakePorts, {
      deadlineEpochMilliseconds: Date.now() + 60_000,
      signal: campaignCancellation.signal,
    });
    const firstStop = events.findIndex((event) => event.startsWith("stop:"));

    expect(events.slice(0, firstStop).filter((event) => event.startsWith("barrier:"))).toEqual([
      "barrier:provenance-before",
      "barrier:run-verified",
      "barrier:run-verified",
      "barrier:observer-subscribed",
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
      "barrier:service-levels-ready",
      "barrier:run-verified",
      "barrier:provenance-after",
      "barrier:campaign-verified",
    ]);
    expect(events.slice(firstStop).filter((event) => event.startsWith("stop:"))).toHaveLength(input().children.length);
    expect(events.at(-1)).toBe("release:campaign-1");
    expect(ownedPolls.size).toBe(0);
    expect(pollCleanupCount).toBe(receipt.actionEvidence.length);
    expect(pollSignals.size).toBe(receipt.actionEvidence.length);
    expect(campaignCancellation.signal.aborted).toBe(false);
    expect(receipt.actionEvidence.map((entry) => (entry as {
      readonly action: HostedCampaignBarrierAction;
    }).action)).toEqual([
      { kind: "provenance-before" },
      { kind: "run-verified", ordinal: 1, runId: "run-1" },
      { kind: "run-verified", ordinal: 2, runId: "run-2" },
      { kind: "observer-subscribed" },
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
      { kind: "service-levels-ready" },
      { kind: "run-verified", ordinal: 3, runId: "run-3" },
      { kind: "provenance-after" },
      { kind: "campaign-verified" },
    ]);
    expect(receipt).toMatchObject({ schemaVersion: 1, campaignId: "campaign-1", teardownComplete: true });
  });

});

describe("hosted campaign coordinator failure handling", () => {

  it("retains the campaign lease when any child cannot be proven stopped", async () => {
    const events: string[] = [];
    const fakePorts = ports(events);
    let attemptedStops = 0;
    fakePorts.stopChild = async (handle) => {
      attemptedStops += 1;
      events.push(`stop:${handle.childId}`);
      if (handle.childId === input().children[0]?.childId) {
        throw new Error("process tree survived cleanup");
      }
    };

    await expect(runHostedCampaign(input(), fakePorts, bounded())).rejects.toThrow(
      /cleanup was incomplete/u,
    );
    expect(attemptedStops).toBe(input().children.length);
    expect(events).not.toContain("release:campaign-1");
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
    const barrier = fakePorts.awaitBarrier.bind(fakePorts);
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
    const stopChild = vi.fn(async (handle: HostedCampaignChildHandle) => { events.push(`stop:${handle.childId}`); });
    fakePorts.stopChild = stopChild;

    await expect(runHostedCampaign(input(), fakePorts, bounded())).rejects.toThrow(/SLA failed/u);
    expect(stopChild).toHaveBeenCalledTimes(5);
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

  it("starts repeated-phase children only at their exact action identity and only once", async () => {
    const events: string[] = [];
    const base = input();
    const movedIdentity = JSON.stringify({ kind: "run-verified", ordinal: 2, runId: "run-2" });
    const configured: HostedCampaignInput = {
      ...base,
      children: [
        ...base.children.filter((candidate) => !candidate.produces.some(({ action }) =>
          JSON.stringify(action) === movedIdentity)),
        oneShotChild("verify-overlap", { kind: "run-verified", ordinal: 2, runId: "run-2" }),
      ],
    };

    await runHostedCampaign(configured, ports(events), bounded());

    expect(events.filter((event) => event === "start:verify-overlap")).toHaveLength(1);
    const runBarriers = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === "barrier:run-verified");
    const verifierStart = events.indexOf("start:verify-overlap");
    expect(events[verifierStart + 1]).toBe("complete:verify-overlap");
    expect(verifierStart + 2).toBe(runBarriers[1]?.index);
  });

  it("rejects a repeated-phase start point that does not exactly exist", async () => {
    const events: string[] = [];
    const invalid: HostedCampaignInput = {
      ...input(),
      children: [
        ...input().children,
        oneShotChild("wrong-run", { kind: "run-verified", ordinal: 2, runId: "run-1" }),
      ],
    };

    await expect(runHostedCampaign(invalid, ports(events), bounded())).rejects.toThrow(/unknown start point/u);
    expect(events).toEqual([]);
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
