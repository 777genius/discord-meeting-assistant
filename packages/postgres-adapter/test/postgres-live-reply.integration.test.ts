import {
  LiveFinalizedMemoryWorker,
  QuestionBinding,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { LiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { describe, expect, it } from "vitest";

import {
  PostgresFinalReplyEvidence,
  PostgresFocusedMemoryRetrieval,
  PostgresLiveFinalizedMemoryLifecycle,
  PostgresLiveFinalizedMemoryStore,
  PostgresLiveMeetingRepository,
  PostgresQuestionAdmissionCommit,
  canonicalFinalReplyTurnHash,
} from "../src/index.js";
import {
  databaseOrSkip,
  evidenceBackedMeeting,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

const botId = "11111111111111111";
const channelId = "22222222222222222";

usePostgresIntegrationDatabase();

async function persistFinalMeeting(
  database: ReturnType<typeof databaseOrSkip>,
) {
  const meeting = evidenceBackedMeeting("meeting-knowledge-final", channelId);
  meeting.beginPublication();
  meeting.completePublication({
    externalPublicationId:
      `discord:v2:channel:${channelId}:message:33333333333333333`,
    idempotencyKey: meeting.publicationIdempotencyKey(),
  });
  const snapshot = meeting.toSnapshot();
  await database.query(
    `
      INSERT INTO meeting_core.meetings (meeting_id, revision, snapshot)
      VALUES ($1, $2, $3::jsonb)
    `,
    [snapshot.meetingId, snapshot.revision, snapshot],
  );
  return snapshot;
}

async function persistActiveLiveProjection(
  database: ReturnType<typeof databaseOrSkip>,
) {
  const meetingId = "meeting-live-reply-1";
  const receipt =
    `discord:v2:channel:${channelId}:message:55555555555555555`;
  const repository = new PostgresLiveMeetingRepository(database);
  const meeting = LiveMeeting.start({
    meetingId,
    publicationTargetId: channelId,
    startedAtMs: 1_000,
  });
  meeting.completeProjection(receipt, meeting.revision);
  await repository.save(meeting.toSnapshot(), null);
  const lifecycle = new PostgresLiveFinalizedMemoryLifecycle(database);
  await lifecycle.registerMeeting({
    actors: [{ actorId: "speaker-a", kind: "human" }],
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "0123456789abcdef0123456789abcdef01234567",
      rosterState: "unsealed",
    },
    lifecycleGeneration: 3,
    meetingId,
    roomId: "room-1",
    scopeId: "scope-1",
  });
  for (let index = 0; index < 12; index += 1) {
    await repository.appendFinalizedTurn(meetingId, {
      endMs: 2_500 + index * 1_000,
      speakerId: "speaker-a",
      startMs: 2_000 + index * 1_000,
      text: index === 0
        ? "EARLY-COMET: The live release owner is Ana."
        : `Ongoing finalized live detail ${index}.`,
      turnId: `live-turn-${String(index).padStart(2, "0")}`,
    });
  }
  const worker = new LiveFinalizedMemoryWorker(
    new PostgresLiveFinalizedMemoryStore(database),
    { hash: canonicalFinalReplyTurnHash },
  );
  for (;;) {
    const result = await worker.executeOnce({ meetingId });
    if (result.status === "idle") {
      break;
    }
    expect(result.status).toBe("applied");
  }
  return { lifecycle, meetingId, receipt, repository };
}

describe("PostgreSQL canonical live reply authority", () => {
  it("drains only the exact canonical thread receipt under the parent target", async (context) => {
    const database = databaseOrSkip(context);
    const live = await persistActiveLiveProjection(database);
    const threadId = "77777777777777777";
    const messageId = "55555555555555555";
    const threadReceipt = `discord:v2:thread:${threadId}:message:${messageId}`;
    const snapshot = await live.repository.findById(live.meetingId);
    if (snapshot === null) {
      throw new Error("live meeting disappeared before thread projection");
    }
    const threaded = LiveMeeting.restore(snapshot);
    threaded.completeProjection(threadReceipt, threaded.revision);
    await live.repository.save(threaded.toSnapshot(), snapshot.revision);
    const evidence = new PostgresFinalReplyEvidence(database, botId);
    const authority = await evidence.findCurrentBinding({
      finalProjectionReceipt: threadReceipt,
      projectionTargetContainerId: channelId,
    });
    if (authority === null) {
      throw new Error("thread authority was not admitted");
    }
    const questionId = "thread-question-1";
    const authorization = {
      actorId: "speaker-a",
      containerId: channelId,
      deliveryContainerId: threadId,
      digest: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      observedAt: new Date().toISOString(),
      policyVersion: "discord.participant-current-results.v1",
      scopeId: authority.scopeId,
      source: "authoritative_remote" as const,
      status: "authorized" as const,
    };
    const binding = QuestionBinding.create({
      authorizationDigest: authorization.digest,
      authorizationPolicyVersion: authorization.policyVersion,
      authorizationPrincipalRef: "opaque-thread-principal",
      ...authority,
      deliveryContainerId: threadId,
      expectedLocale: "en",
      policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
      questionHash: "b".repeat(64),
      questionId,
      requesterSubject: "c".repeat(64),
    }).toSnapshot();
    const admissions = new PostgresQuestionAdmissionCommit(database, botId);
    await expect(admissions.commit({
      authorization,
      binding,
      questionText: "What was decided?",
      ratePolicy: {
        guildQuestionsPerHour: 10,
        jobTtlSeconds: 900,
        requesterQuestionsPerHour: 10,
      },
    })).resolves.toMatchObject({ status: "committed" });

    await expect(admissions.withdrawProjection({
      finalProjectionReceipt:
        `discord:v2:channel:${channelId}:message:${messageId}`,
    })).resolves.toEqual([]);
    await expect(admissions.withdrawProjection({
      finalProjectionReceipt:
        `discord:v2:thread:88888888888888888:message:${messageId}`,
    })).resolves.toEqual([]);
    await expect(evidence.findCurrentBinding({
      finalProjectionReceipt: threadReceipt,
      projectionTargetContainerId: channelId,
    })).resolves.not.toBeNull();
    await expect(admissions.withdrawProjection({
      finalProjectionReceipt: threadReceipt,
    })).resolves.toEqual([questionId]);
    await expect(evidence.findCurrentBinding({
      finalProjectionReceipt: threadReceipt,
      projectionTargetContainerId: channelId,
    })).resolves.toBeNull();
  });

  it("retrieves an early fact, rejects replacement drift, and transitions to final", async (context) => {
    const database = databaseOrSkip(context);
    const live = await persistActiveLiveProjection(database);
    const evidence = new PostgresFinalReplyEvidence(database, botId);
    const authority = await evidence.findCurrentBinding({
      finalProjectionReceipt: live.receipt,
      projectionTargetContainerId: channelId,
    });
    expect(authority).toMatchObject({
      meetingId: live.meetingId,
      roomId: "room-1",
      scopeId: "scope-1",
      transcriptVersion: 12,
    });
    if (authority === null) {
      return;
    }
    const retrieval = await new PostgresFocusedMemoryRetrieval(database, botId)
      .retrieve({
        canonicalEvidenceHash: authority.canonicalEvidenceHash,
        expectedAuthorityGeneration: authority.memoryGeneration,
        finalProjectionReceipt: authority.finalProjectionReceipt,
        maximumCandidates: 4,
        meetingId: authority.meetingId,
        meetingRevision: authority.meetingRevision,
        neighborTurns: 1,
        projectionTargetContainerId: authority.projectionTargetContainerId,
        question: "Who owns EARLY-COMET release?",
        roomId: authority.roomId,
        scopeId: authority.scopeId,
        transcriptId: authority.transcriptId,
        transcriptVersion: authority.transcriptVersion,
      });
    expect(retrieval.status).toBe("current");
    if (retrieval.status === "current") {
      const hydrated = await evidence.rehydrateSelectedEvidence({
        authorizationDigest: "a".repeat(64),
        authorizationPolicyVersion: "discord.participant-current-results.v1",
        authorizationPrincipalRef: "opaque-live-principal",
        ...authority,
        deliveryContainerId: authority.projectionTargetContainerId,
        expectedLocale: "en",
        policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
        questionHash: "b".repeat(64),
        questionId: "live-question-1",
        requesterSubject: "c".repeat(64),
      }, retrieval.candidates);
      expect(hydrated.status).toBe("current");
      if (hydrated.status === "current") {
        expect(hydrated.turns.map(({ text }) => text)).toContain(
          "EARLY-COMET: The live release owner is Ana.",
        );
        expect(hydrated.turns.length).toBeLessThan(12);
      }
    }
    await rotateAndEndLiveProjection(live, evidence);
    const final = await persistFinalMeeting(database);
    await expect(evidence.findCurrentBinding({
      finalProjectionReceipt: final.publication?.externalPublicationId ?? "",
      projectionTargetContainerId: channelId,
    })).resolves.toMatchObject({ transcriptId: final.transcript?.transcriptId });
  });
});

async function rotateAndEndLiveProjection(
  live: Awaited<ReturnType<typeof persistActiveLiveProjection>>,
  evidence: PostgresFinalReplyEvidence,
): Promise<void> {
  const snapshot = await live.repository.findById(live.meetingId);
  if (snapshot === null) {
    throw new Error("live meeting disappeared");
  }
  const replacementReceipt =
    `discord:v2:channel:${channelId}:message:66666666666666666`;
  const rotated = LiveMeeting.restore(snapshot);
  rotated.completeProjection(replacementReceipt, rotated.revision);
  await live.repository.save(rotated.toSnapshot(), snapshot.revision);
  await expect(evidence.findCurrentBinding({
    finalProjectionReceipt: live.receipt,
    projectionTargetContainerId: channelId,
  })).resolves.toBeNull();
  await expect(evidence.findCurrentBinding({
    finalProjectionReceipt: replacementReceipt,
    projectionTargetContainerId: "wrong-channel",
  })).resolves.toBeNull();
  const current = await live.repository.findById(live.meetingId);
  if (current === null) {
    throw new Error("live meeting disappeared before finalization");
  }
  const ended = LiveMeeting.restore(current);
  ended.end(30_000);
  await live.repository.save(ended.toSnapshot(), current.revision);
  await live.lifecycle.finishMeeting(live.meetingId);
  await expect(evidence.findCurrentBinding({
    finalProjectionReceipt: replacementReceipt,
    projectionTargetContainerId: channelId,
  })).resolves.toBeNull();
}
