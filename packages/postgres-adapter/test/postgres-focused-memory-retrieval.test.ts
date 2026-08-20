import {
  EvidenceBackedSummary,
} from "@discord-meeting/meeting-core/meeting-intelligence";
import {
  createFocusedRetrievalGroundingPlan,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  FinalTranscript,
  type TranscriptTurnSnapshot,
} from "@discord-meeting/meeting-core/transcription";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  PostgresFinalReplyEvidence,
  PostgresFocusedMemoryRetrieval,
  PostgresLiveFinalizedMemoryQuery,
} from "../src/index.js";
import { resolveFinalReplyAuthority } from "../src/postgres-final-reply-evidence.js";
import { recordedMeeting } from "./postgres-integration-fixtures.js";

const botId = "11111111111111111";

function corpusTurn(index: number): TranscriptTurnSnapshot {
  const startMs = index * 10_000;
  let text = `Synthetic planning detail ${index}; шум noise marker-${index}.`;
  if (index === 0) {
    text = "ORION-START: The Atlas rollout owner was initially recorded as Ana.";
  } else if (index === 72) {
    text = "The deployment was initially planned for Friday at 09:00 UTC.";
  } else if (index === 180) {
    text = "The initial Atlas retention proposal was three days.";
  } else if (index === 181) {
    text = "The Atlas retention dashboard is a near-duplicate draft artifact.";
  } else if (index === 648) {
    text = "Correction: the deployment is Monday at 11:30 UTC, not Friday.";
  } else if (index === 360) {
    text = "MIDDLE-MAPLE: Срок релиза сначала назначили на пятницу.";
  } else if (index === 540) {
    text = "Исправление: срок релиза перенесли на понедельник.";
  } else if (index === 719) {
    text = "END-QUARTZ: Correction: final Atlas retention is thirty days and Ana owns rollout.";
  }
  return {
    endMs: startMs + 2_000,
    speakerId: index % 2 === 0 ? "speaker-a" : "speaker-b",
    startMs,
    text,
    turnId: `turn-${String(index).padStart(4, "0")}`,
  };
}

function twoHourSnapshot(turnCount = 720) {
  const meeting = recordedMeeting("focused-memory-two-hour");
  const turns = Array.from({ length: turnCount }, (_, index) => corpusTurn(index));
  meeting.beginTranscription();
  const transcript = FinalTranscript.create({
    recordingId: meeting.recording.recordingId,
    transcriptId: "transcript-focused-memory-two-hour",
    turns,
    version: 1,
  });
  meeting.completeTranscription(transcript);
  meeting.beginSummary();
  meeting.completeSummary(EvidenceBackedSummary.create({
    actionItems: [],
    decisions: [{
      decisionId: "decision-fixture",
      evidenceTurnIds: ["turn-0000"],
      text: "Use a synthetic corpus.",
    }],
    openQuestions: [],
    overview: "Synthetic focused-memory qualification corpus.",
    summaryId: "summary-focused-memory-two-hour",
    title: "Synthetic qualification",
    transcriptId: transcript.transcriptId,
    version: 1,
  }, transcript));
  meeting.beginPublication();
  meeting.completePublication({
    externalPublicationId:
      "discord:v2:channel:22222222222222222:message:33333333333333333",
    idempotencyKey: meeting.publicationIdempotencyKey(),
    publisherIdentity: botId,
  });
  return meeting.toSnapshot();
}

function snapshotPool(snapshot: ReturnType<typeof twoHourSnapshot>): Pool {
  return {
    query: (statement: string) => Promise.resolve({
      rowCount: 1,
      rows: statement.includes("AS historical_current")
        ? [{ historical_current: false, meeting_id: snapshot.meetingId, snapshot }]
        : [{ snapshot, unavailable: false }],
    }),
  } as unknown as Pool;
}

function retrievalInput(
  snapshot: ReturnType<typeof twoHourSnapshot>,
  question: string,
) {
  const authority = resolveFinalReplyAuthority(snapshot, botId);
  if (authority === null) {
    throw new Error("synthetic meeting did not produce final-reply authority");
  }
  return {
    authority,
    input: {
      canonicalEvidenceHash: authority.binding.canonicalEvidenceHash,
      expectedAuthorityGeneration: authority.binding.memoryGeneration,
      finalProjectionReceipt: authority.binding.finalProjectionReceipt,
      maximumCandidates: 24,
      meetingId: authority.binding.meetingId,
      meetingRevision: authority.binding.meetingRevision,
      neighborTurns: 2,
      projectionTargetContainerId: authority.binding.projectionTargetContainerId,
      question,
      roomId: authority.binding.roomId,
      scopeId: authority.binding.scopeId,
      transcriptId: authority.binding.transcriptId,
      transcriptVersion: authority.binding.transcriptVersion,
    },
  };
}

describe("PostgreSQL focused current-meeting memory", () => {
  it("returns only bounded focused locators for a short current transcript", async () => {
    const snapshot = twoHourSnapshot(16);
    const retrieval = new PostgresFocusedMemoryRetrieval(snapshotPool(snapshot), botId);
    const { input } = retrievalInput(snapshot, "What was decided about Atlas?");
    const result = await retrieval.retrieve({ ...input, maximumCandidates: 4 });

    expect(result.status).toBe("current");
    if (result.status === "current") {
      expect(result.candidates.length).toBeLessThanOrEqual(4);
      expect(result.candidates.length).toBeLessThan(16);
      expect(result.candidates.every((candidate) => !("text" in candidate)))
        .toBe(true);
    }

    const noHit = await retrieval.retrieve({
      ...input,
      question: "Meteorological zephyr calibration?",
    });
    expect(noHit).toEqual({ schemaVersion: 1, status: "low_coverage" });
  });

  it("abstains instead of selecting every turn from a nominally small transcript", async () => {
    const snapshot = twoHourSnapshot(1);
    const { input } = retrievalInput(snapshot, "Who owns the Atlas rollout?");

    await expect(new PostgresFocusedMemoryRetrieval(snapshotPool(snapshot), botId)
      .retrieve(input)).resolves.toEqual({
        schemaVersion: 1,
        status: "low_coverage",
      });
  });

  it("destroys an in-flight live-memory connection when its signal aborts", async () => {
    const releases: Array<boolean | Error | undefined> = [];
    let rejectQuery: ((error: Error) => void) | undefined;
    let markQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      markQueryStarted = () => {
        resolve();
      };
    });
    const pool = {
      connect: async () => ({
        processID: 12_345,
        query: () => new Promise((_resolve, reject) => {
          rejectQuery = reject;
          markQueryStarted();
        }),
        release: (destroy?: boolean | Error) => {
          releases.push(destroy);
          if (destroy === true) {
            rejectQuery?.(new Error("connection destroyed"));
          }
        },
      }),
    } as unknown as Pool;
    const controller = new AbortController();
    const pending = new PostgresLiveFinalizedMemoryQuery(pool, {
      cancelAndVerifyInactive: async (backendPid) => {
        expect(backendPid).toBe(12_345);
      },
    }).resolveContext({
      meetingId: "abortable-live-memory",
      requesterActorId: "synthetic-requester",
      roomId: "synthetic-room",
      signal: controller.signal,
    });
    await queryStarted;
    expect(rejectQuery).toBeDefined();
    controller.abort(new Error("synthetic cancellation"));

    await expect(pending).rejects.toThrow("synthetic cancellation");
    expect(releases).toEqual([true]);
  });

  it("destroys a connection when cancellation races its acquisition", async () => {
    const controller = new AbortController();
    const releases: Array<boolean | Error | undefined> = [];
    let queryCalled = false;
    const pool = {
      connect: async () => {
        controller.abort(new Error("synthetic acquisition cancellation"));
        return {
          processID: 12_346,
          query: () => {
            queryCalled = true;
            return Promise.resolve({ rowCount: 0, rows: [] });
          },
          release: (destroy?: boolean | Error) => {
            releases.push(destroy);
          },
        };
      },
    } as unknown as Pool;

    await expect(new PostgresLiveFinalizedMemoryQuery(pool).resolveContext({
      meetingId: "acquisition-race-live-memory",
      requesterActorId: "synthetic-requester",
      roomId: "synthetic-room",
      signal: controller.signal,
    })).rejects.toThrow("synthetic acquisition cancellation");
    expect(queryCalled).toBe(false);
    expect(releases).toEqual([true]);
  });

  it("scans a synthetic two-hour corpus but returns only bounded references for local rehydration", async () => {
    const snapshot = twoHourSnapshot();
    const pool = snapshotPool(snapshot);
    const { authority, input } = retrievalInput(
      snapshot,
      "When is the corrected deployment time?",
    );
    const result = await new PostgresFocusedMemoryRetrieval(pool, botId)
      .retrieve(input);

    expect(result.status).toBe("current");
    if (result.status !== "current") {
      return;
    }
    expect(result.authorityGeneration).toBe(authority.binding.memoryGeneration);
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.candidates.length).toBeLessThanOrEqual(24);
    expect(result.candidates.map(({ turnId }) => turnId)).toEqual(
      expect.arrayContaining(["turn-0072", "turn-0648"]),
    );
    expect(result.candidates.every((candidate) =>
      !("text" in candidate)
    )).toBe(true);
    expect(result.candidates.map(({ turnId }) => turnId)).not.toEqual(
      snapshot.transcript?.turns.slice(0, result.candidates.length)
        .map(({ turnId }) => turnId),
    );

    const binding = {
      authorizationDigest: "a".repeat(64),
      authorizationPolicyVersion: "discord.participant-current-results.v1",
      authorizationPrincipalRef: "opaque",
      ...authority.binding,
      deliveryContainerId: authority.binding.projectionTargetContainerId,
      expectedLocale: "en" as const,
      policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
      questionHash: "c".repeat(64),
      questionId: "question-1",
      requesterSubject: "d".repeat(64),
    };
    const hydrated = await new PostgresFinalReplyEvidence(pool, botId)
      .rehydrateSelectedEvidence(binding, result.candidates);
    expect(hydrated.status).toBe("current");
    if (hydrated.status === "current") {
      expect(hydrated.turns.map(({ text }) => text).join("\n")).toContain(
        "Correction: the deployment is Monday",
      );
      expect(hydrated.turns).toHaveLength(result.candidates.length);
    }
  });

  it("finds distant Russian corrections and fails closed for stale generation or low coverage", async () => {
    const snapshot = twoHourSnapshot();
    const retrieval = new PostgresFocusedMemoryRetrieval(snapshotPool(snapshot), botId);
    const russian = retrievalInput(
      snapshot,
      "Какой исправленный срок релиза?",
    );
    const result = await retrieval.retrieve(russian.input);
    expect(result.status).toBe("current");
    if (result.status === "current") {
      expect(result.candidates.map(({ turnId }) => turnId)).toContain("turn-0540");
    }

    await expect(retrieval.retrieve({
      ...russian.input,
      expectedAuthorityGeneration: `focused-memory:v1:${"f".repeat(64)}`,
    })).resolves.toEqual({ schemaVersion: 1, status: "stale" });
    await expect(retrieval.retrieve({
      ...russian.input,
      question: "Meteorological zephyr calibration?",
    })).resolves.toEqual({ schemaVersion: 1, status: "low_coverage" });
  });

  it("selects multi-hop evidence at the start, quarter, and end without returning corpus text", async () => {
    const snapshot = twoHourSnapshot();
    const retrieval = new PostgresFocusedMemoryRetrieval(snapshotPool(snapshot), botId);
    const { input } = retrievalInput(
      snapshot,
      "What is the corrected Atlas rollout owner and retention?",
    );
    const result = await retrieval.retrieve(input);

    expect(result.status).toBe("current");
    if (result.status === "current") {
      expect(result.candidates.map(({ turnId }) => turnId)).toEqual(
        expect.arrayContaining(["turn-0000", "turn-0180", "turn-0719"]),
      );
      expect(result.candidates.length).toBeLessThanOrEqual(input.maximumCandidates);
      const scores = result.candidates.map(({ relevanceScore }) => relevanceScore ?? -1);
      expect(scores.every((score) => score >= 0 && score <= 1)).toBe(true);
      expect(scores).toEqual(scores.toSorted((left, right) => right - left));
      expect(JSON.stringify(result.candidates)).not.toContain("thirty days");
    }
  });

  it.each([
    ["start", "What was ORION-START?", "turn-0000"],
    ["middle", "What was MIDDLE-MAPLE?", "turn-0360"],
    ["end", "What was END-QUARTZ?", "turn-0719"],
  ] as const)("uses bounded focused evidence and citations at the %s", async (
    _position,
    question,
    expectedTurnId,
  ) => {
    const snapshot = twoHourSnapshot();
    const pool = snapshotPool(snapshot);
    const { authority, input } = retrievalInput(snapshot, question);
    const result = await new PostgresFocusedMemoryRetrieval(pool, botId)
      .retrieve({ ...input, maximumCandidates: 5 });
    expect(result.status).toBe("current");
    if (result.status !== "current") {
      return;
    }
    expect(result.candidates.length).toBeLessThanOrEqual(5);
    expect(result.candidates.map(({ turnId }) => turnId)).toContain(expectedTurnId);
    const binding = {
      authorizationDigest: "a".repeat(64),
      authorizationPolicyVersion: "discord.participant-current-results.v1",
      authorizationPrincipalRef: "opaque",
      ...authority.binding,
      deliveryContainerId: authority.binding.projectionTargetContainerId,
      expectedLocale: "en" as const,
      policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
      questionHash: "c".repeat(64),
      questionId: `question-${_position}`,
      requesterSubject: "d".repeat(64),
    };
    const hydrated = await new PostgresFinalReplyEvidence(pool, botId)
      .rehydrateSelectedEvidence(binding, result.candidates);
    expect(hydrated.status).toBe("current");
    if (hydrated.status !== "current") {
      return;
    }
    const plan = createFocusedRetrievalGroundingPlan({
      authorityGeneration: result.authorityGeneration,
      coverage: "sufficient",
      humanActorIds: binding.humanActorIds,
      turns: hydrated.turns,
    });
    expect(plan.mode).toBe("focused_retrieval");
    expect(plan.evidence.map(({ turnId }) => turnId)).toContain(expectedTurnId);
    expect(plan.evidence.every(({ evidenceId }) => evidenceId.startsWith("evidence-")))
      .toBe(true);
    expect(plan.evidence).toHaveLength(result.candidates.length);
  });

  it("never widens a focused request to the complete current transcript", async () => {
    const snapshot = twoHourSnapshot();
    const { input } = retrievalInput(snapshot, "What was decided about Atlas?");
    const result = await new PostgresFocusedMemoryRetrieval(
      snapshotPool(snapshot),
      botId,
    ).retrieve({ ...input, maximumCandidates: 8 });

    expect(result.status).toBe("current");
    if (result.status === "current") {
      expect(result.candidates.length).toBeLessThanOrEqual(8);
      expect(result.candidates.length).toBeLessThan(snapshot.transcript?.turns.length ?? 0);
    }
  });
});

describe("PostgreSQL focused retrieval cues", () => {
  it("resolves configured real names without exposing them as evidence", async () => {
    const snapshot = twoHourSnapshot();
    const { input } = retrievalInput(
      snapshot,
      "Что Влад сказал latest about Atlas?",
    );
    const result = await new PostgresFocusedMemoryRetrieval(
      snapshotPool(snapshot),
      botId,
      { "speaker-b": ["Влад", "Vlad"] },
    ).retrieve({ ...input, maximumCandidates: 6, neighborTurns: 1 });

    expect(result.status).toBe("current");
    if (result.status === "current") {
      expect(result.candidates[0]?.turnId).toBe("turn-0719");
      expect(JSON.stringify(result.candidates)).not.toContain("Влад");
    }
  });

  it("uses explicit speaker and timeline cues without widening the candidate set", async () => {
    const snapshot = twoHourSnapshot();
    const { input } = retrievalInput(
      snapshot,
      "What did speaker-b say latest about Atlas?",
    );
    const result = await new PostgresFocusedMemoryRetrieval(
      snapshotPool(snapshot),
      botId,
    ).retrieve({ ...input, maximumCandidates: 6, neighborTurns: 1 });

    expect(result.status).toBe("current");
    if (result.status === "current") {
      expect(result.candidates[0]?.turnId).toBe("turn-0719");
      expect(result.candidates.length).toBeLessThanOrEqual(6);
      expect(result.candidates.map(({ turnId }) => turnId))
        .toEqual(expect.arrayContaining(["turn-0718", "turn-0719"]));
    }
  });
});
