import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildHistoricalIndexPlan,
  buildHistoricalIndexPlanFromPreparedWindows,
  type AcceptedFinalMeetingV1,
  type HistoricalEvidenceBlockPolicyV1,
  HistoricalIndexPlannerUnavailableError,
  type HistoricalOpaqueIdPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  CooperativeHistoricalIndexPlanner,
  PinnedMultilingualMiniLmTokenizer,
  Sha256HistoricalReceiptDigest,
} from "../src/index.js";

class DeterministicIds implements HistoricalOpaqueIdPort {
  public keyedId(namespace: string, parts: readonly string[]): string {
    let hash = 2_166_136_261;
    for (const character of `${namespace}\u0000${parts.join("\u0000")}`) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
}

const policy: HistoricalEvidenceBlockPolicyV1 = Object.freeze({
  maximumEmbeddingTokens: 96,
  maxBlockUtf8Bytes: 4_096,
  maxBlocksPerMeeting: 500,
  maxTurnsPerBlock: 14,
  turnOverlap: 2,
  version: "meeting-knowledge.block-policy.v1",
});

function meeting(texts: readonly string[]): AcceptedFinalMeetingV1 {
  return Object.freeze({
    authoritativeDurationMs: 7_200_000,
    binding: Object.freeze({
      acceptedMeetingRevision: 7,
      desiredGeneration: 2,
      evidencePolicyVersion: "meeting-knowledge.evidence-block.v1",
      meetingId: "meeting-1",
      releaseId: "release-1",
      roomId: "room-1",
      schemaVersion: 1,
      scopeId: "scope-1",
      transcriptId: "transcript-1",
      transcriptVersion: 3,
    }),
    humanTurns: Object.freeze(texts.map((text, index) => Object.freeze({
      endMs: index * 4_000 + 3_900,
      speakerId: `speaker-${index % 7}`,
      startMs: index * 4_000,
      text,
      turnId: `turn-${index}`,
    }))),
    schemaVersion: 1,
  });
}

function twoHourMeeting(): AcceptedFinalMeetingV1 {
  return meeting(Array.from({ length: 1_779 }, (_, index) =>
    index % 3 === 0
      ? `Routine English planning segment ${index} with release context.`
      : index % 3 === 1
        ? `Обычное русское обсуждение ${index} с контекстом релиза.`
        : `Mixed планирование ${index} and operational follow-up.`
  ));
}

function slowMeeting(): AcceptedFinalMeetingV1 {
  return meeting(Array.from({ length: 300 }, (_, index) =>
    `Long planning turn ${index} with multilingual release context.`));
}

describe("cooperative historical window planner", () => {
  const active: CooperativeHistoricalIndexPlanner[] = [];

  afterEach(async () => {
    await Promise.all(active.splice(0).map((planner) => planner.close()));
  });

  it("matches the exact synchronous oracle and keeps the main event loop responsive", async () => {
    const planner = new CooperativeHistoricalIndexPlanner();
    active.push(planner);
    await planner.start();
    await planner.prepareWindows(meeting(["tokenizer warmup"]), policy);
    const source = twoHourMeeting();
    let prior = performance.now();
    let maximumHeartbeatDelayMs = 0;
    const heartbeatDelaysMs: number[] = [];
    let observeFirstHeartbeat: (() => void) | undefined;
    const firstHeartbeatObserved = new Promise<void>((resolve) => {
      observeFirstHeartbeat = resolve;
    });
    const heartbeat = setInterval(() => {
      const current = performance.now();
      maximumHeartbeatDelayMs = Math.max(maximumHeartbeatDelayMs, current - prior);
      heartbeatDelaysMs.push(current - prior);
      prior = current;
      observeFirstHeartbeat?.();
      observeFirstHeartbeat = undefined;
    }, 5);
    await firstHeartbeatObserved;
    const prepared = await planner.prepareWindows(source, policy);
    clearInterval(heartbeat);

    const ids = new DeterministicIds();
    const actual = buildHistoricalIndexPlanFromPreparedWindows(
      source,
      ids,
      policy,
      prepared,
      new Sha256HistoricalReceiptDigest(),
    );
    const expected = buildHistoricalIndexPlan(
      source,
      ids,
      policy,
      new PinnedMultilingualMiniLmTokenizer(),
    );

    expect(actual).toEqual(expected);
    expect(actual.documents).toHaveLength(349);
    expect(actual.documents).toHaveLength(prepared.windows.length);
    expect(actual.documents.every(({ manifest }) =>
      manifest.embeddingTokenEstimate <= 96
    )).toBe(true);
    const sortedHeartbeatDelays = heartbeatDelaysMs.toSorted((left, right) => left - right);
    expect(heartbeatDelaysMs.length).toBeGreaterThan(0);
    const p95HeartbeatDelayMs = sortedHeartbeatDelays[
      Math.floor(sortedHeartbeatDelays.length * 0.95)
    ] ?? 0;
    console.info(JSON.stringify({ maximumHeartbeatDelayMs, p95HeartbeatDelayMs }));
    expect(heartbeatDelaysMs.length).toBeGreaterThan(0);
    expect(maximumHeartbeatDelayMs).toBeLessThan(100);
  }, 75_000);

  it("splits astral and ZWJ-heavy Unicode only on canonical code-point ranges", async () => {
    const planner = new CooperativeHistoricalIndexPlanner();
    active.push(planner);
    const astral = String.fromCodePoint(0x12_000).repeat(2_000);
    const joined = "👩‍🚀".repeat(5_000);
    const rawJoiner = "\u200D".repeat(5_000);
    const source = meeting([astral, joined, rawJoiner]);
    const prepared = await planner.prepareWindows(source, policy);
    const plan = buildHistoricalIndexPlanFromPreparedWindows(
      source,
      new DeterministicIds(),
      policy,
      prepared,
      new Sha256HistoricalReceiptDigest(),
    );
    const oracle = buildHistoricalIndexPlan(
      source,
      new DeterministicIds(),
      policy,
      new PinnedMultilingualMiniLmTokenizer(),
    );

    expect(plan).toEqual(oracle);

    const deoverlapped = prepared.windows.flatMap((window, index) => {
      const prior = prepared.windows[index - 1];
      const overlap = prior !== undefined &&
          prior.segments.length > prepared.effectiveTurnOverlap + 1
        ? prepared.effectiveTurnOverlap
        : 0;
      return window.segments.slice(overlap);
    });
    for (const [turnId, original] of [
      ["turn-0", astral],
      ["turn-1", joined],
      ["turn-2", rawJoiner],
    ]) {
      expect(deoverlapped
        .filter((segment) => segment.turnId === turnId)
        .map((segment) => segment.text)
        .join("")).toBe(original);
    }
    expect(plan.documents.every(({ embeddingText, manifest }) =>
      new TextEncoder().encode(embeddingText).byteLength <= 4_096 &&
      manifest.embeddingTokenEstimate <= 96
    )).toBe(true);
  }, 30_000);

  it("reduces overlap deterministically and never exceeds 500 windows", async () => {
    const planner = new CooperativeHistoricalIndexPlanner();
    active.push(planner);
    const source = meeting(Array.from({ length: 1_003 }, (_, index) =>
      `turn ${index}`
    ));
    const adaptivePolicy = Object.freeze({
      ...policy,
      maximumEmbeddingTokens: 512,
      maxTurnsPerBlock: 4,
    });
    const first = await planner.prepareWindows(source, adaptivePolicy);
    const second = await planner.prepareWindows(source, adaptivePolicy);

    expect(second).toEqual(first);
    expect(first.windows.length).toBeLessThanOrEqual(500);
    expect(first.effectiveTurnOverlap).toBeLessThanOrEqual(1);
  }, 30_000);

  it("rejects tampered request, result, and planning-profile receipts", async () => {
    const planner = new CooperativeHistoricalIndexPlanner();
    active.push(planner);
    const source = meeting(["canonical evidence"]);
    const prepared = await planner.prepareWindows(source, policy);
    const digest = new Sha256HistoricalReceiptDigest();
    const build = (candidate: typeof prepared): unknown =>
      buildHistoricalIndexPlanFromPreparedWindows(
        source,
        new DeterministicIds(),
        policy,
        candidate,
        digest,
      );
    const invalidSha = `sha256:${"0".repeat(64)}` as const;
    for (const candidate of [
      { ...prepared, receipt: { ...prepared.receipt, requestSha256: invalidSha } },
      { ...prepared, receipt: { ...prepared.receipt, resultSha256: invalidSha } },
      {
        ...prepared,
        planningProfile: { ...prepared.planningProfile, digestSha256: invalidSha },
      },
    ]) {
      expect(() => build(candidate)).toThrow(/receipt is invalid/u);
    }
  });

  it("fails a second admission fast while a planning job is active", async () => {
    const planner = new CooperativeHistoricalIndexPlanner();
    active.push(planner);
    const controller = new AbortController();
    const first = planner.prepareWindows(slowMeeting(), policy, {
      signal: controller.signal,
    });

    const startedAt = performance.now();
    await expect(planner.prepareWindows(meeting(["second"]), policy))
      .rejects.toBeInstanceOf(HistoricalIndexPlannerUnavailableError);
    expect(performance.now() - startedAt).toBeLessThan(100);

    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
  }, 30_000);

  it("releases admission after an aborted job", async () => {
    const planner = new CooperativeHistoricalIndexPlanner();
    active.push(planner);
    const controller = new AbortController();
    const aborted = planner.prepareWindows(slowMeeting(), policy, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    const prepared = await planner.prepareWindows(meeting(["reusable"]), policy);
    expect(Array.isArray(prepared.windows)).toBe(true);
  }, 30_000);

  it("bounds a timed-out job and remains reusable", async () => {
    const planner = new CooperativeHistoricalIndexPlanner({
      jobTimeoutMs: 100,
    });
    active.push(planner);
    await planner.start();
    await planner.prepareWindows(meeting(["deadline warmup"]), policy);
    const startedAt = performance.now();

    await expect(planner.prepareWindows(slowMeeting(), policy))
      .rejects.toBeInstanceOf(HistoricalIndexPlannerUnavailableError);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    const prepared = await planner.prepareWindows(meeting(["reusable"]), policy);
    expect(Array.isArray(prepared.windows)).toBe(true);
  }, 30_000);

  it("interrupts a job on close and rejects all future work", async () => {
    const planner = new CooperativeHistoricalIndexPlanner();
    active.push(planner);
    const planning = planner.prepareWindows(slowMeeting(), policy);
    const startedAt = performance.now();
    await planner.close();

    await expect(planning).rejects.toBeInstanceOf(
      HistoricalIndexPlannerUnavailableError,
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    await expect(planner.prepareWindows(meeting(["closed"]), policy))
      .rejects.toBeInstanceOf(HistoricalIndexPlannerUnavailableError);
  }, 30_000);
});
