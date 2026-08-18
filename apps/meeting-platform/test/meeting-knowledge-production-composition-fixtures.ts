import {
  INFINITY_CONTEXT_SDK_PROVENANCE,
} from "@discord-meeting/infinity-context-adapter";
import type {
  DisposableInfinityHttpService,
} from "@discord-meeting/infinity-context-adapter/test-support";
import type {
  HistoricalAuthorizationPort,
  RehydratedEvidenceTurn,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  EvidenceBackedSummary,
} from "@discord-meeting/meeting-core/meeting-intelligence";
import {
  Meeting,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core/meeting-lifecycle";
import { FinalTranscript } from "@discord-meeting/meeting-core/transcription";
import type { Logger } from "@discord-meeting/observability-adapter";
import {
  PostgresMeetingRepository,
} from "@discord-meeting/postgres-adapter";
import {
  auditedSubscriptionRuntimePackageVersion,
  canonicalJsonSha256,
  subscriptionRuntimeCliEngine,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeTaskResult,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";
import type { Pool } from "pg";

import type { PlatformConfig } from "../src/config.js";
import {
  createPlatformHistoricalMemory,
  type PlatformHistoricalMemoryRuntime,
} from "../src/composition/historical-memory.js";

export const botApplicationIdentity = "111111111111111111";
export const resultsContainerId = "222222222222222222";
export const scopeId = "333333333333333333";
export const roomId = "444444444444444444";
export const historicalMeetingId = "synthetic-two-hour-history";
export const currentMeetingId = "synthetic-current-meeting";

export const retainedProductionEmbeddingProfileAttestation = Object.freeze({
  embeddingProfile:
    "local-open-source-paraphrase-multilingual-minilm-l12-v2-hybrid-bm25.r73",
  embeddingProfileDigestSha256:
    "sha256:5ecd36edd098940cd8a6540509f90815ddc1802b4410ced2bf063c0f8c650cac",
  productionSemanticQualification: true as const,
  qualificationManifestSha256:
    INFINITY_CONTEXT_SDK_PROVENANCE
      .retainedProductionSemanticQualificationManifestSha256,
  releaseRevision:
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedProductionSemanticReleaseRevision,
  schemaVersion: 1 as const,
});

export const positionalNeedles = Object.freeze([
  { marker: "ORCHID-ALPHA", position: 0 },
  { marker: "CEDAR-BRAVO", position: 72 },
  { marker: "MAPLE-CHARLIE", position: 180 },
  { marker: "NEBULA-DELTA", position: 360 },
  { marker: "QUARTZ-ECHO", position: 540 },
  { marker: "WILLOW-FOXTROT", position: 648 },
  { marker: "PINE-GOLF", position: 719 },
]);

export function requiredHistoricalRuntime(
  pool: Pool,
  infinity: DisposableInfinityHttpService,
  indexingEnabled: boolean,
  searchEnabled: boolean,
  environment: "production" | "test" = "test",
  productionEmbeddingProfileAttestation: NonNullable<
    PlatformConfig["infinityContext"]
  >["activation"]["productionEmbeddingProfileAttestation"] = null,
): PlatformHistoricalMemoryRuntime {
  const runtime = createPlatformHistoricalMemory({
    config: platformConfig(
      infinity.baseUrl,
      indexingEnabled,
      searchEnabled,
      environment,
      productionEmbeddingProfileAttestation,
    ),
    logger: silentLogger,
    pool,
    runtimeTransport: syntheticCoverageRuntime,
  });
  if (runtime === undefined) {
    throw new Error("synthetic Infinity configuration did not compose a runtime");
  }
  return runtime;
}

const syntheticLauncherSha256 = "d".repeat(64);

class SyntheticCoverageRuntime implements SubscriptionRuntimeTransportPort {
  checkHealth() {
    return Promise.resolve({
      launcherSha256: syntheticLauncherSha256,
      runtimeEngine: subscriptionRuntimeCliEngine,
      runtimeVersion: auditedSubscriptionRuntimePackageVersion,
      status: "serving" as const,
      warningCodes: [],
    });
  }

  execute(
    request: SubscriptionRuntimeAgentTaskRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SubscriptionRuntimeTaskResult> {
    options.signal?.throwIfAborted();
    const prompt = JSON.parse(request.task.prompt) as {
      readonly evidence: readonly {
        readonly evidenceId: string;
        readonly text: string;
      }[];
      readonly question: string;
    };
    const positionalQuestion = /positional marker/iu.test(prompt.question);
    const claims = prompt.evidence.filter(({ text }) =>
      positionalQuestion
        ? /(?:ORCHID|CEDAR|MAPLE|NEBULA|QUARTZ|WILLOW|PINE)-[A-Z]+/u.test(text)
        : /\bagreed\b|\bapproved\b|\brejected\b|\bcorrection\b|договорил|согласил/iu.test(text)
    ).map(({ evidenceId }) => ({
      evidenceIds: [evidenceId],
      relevance: "direct",
    }));
    const output: JsonObject = {
      claims,
      reviewedEvidenceIds: prompt.evidence.map(({ evidenceId }) => evidenceId),
      status: claims.length === 0 ? "no_match" : "claims",
    };
    return Promise.resolve({
      executionAttestation: {
        canonicalRequestSha256: canonicalJsonSha256(request),
        launcherSha256: syntheticLauncherSha256,
        model: request.task.controls.model,
        provider: "codex",
        purpose: request.context.purpose,
        reasoningEffort: request.task.controls.reasoningEffort,
        requestId: request.runId,
        runtimeEngine: subscriptionRuntimeCliEngine,
        runtimePackageVersion: auditedSubscriptionRuntimePackageVersion,
        schemaVersion: 1,
        selectedOutputKind: "structured_output",
        selectedOutputSha256: canonicalJsonSha256(output),
      },
      protocolVersion: 1,
      status: "completed",
      structuredOutput: output,
    });
  }
}

export const syntheticCoverageRuntime = new SyntheticCoverageRuntime();

export function platformConfig(
  baseUrl: string,
  indexingEnabled: boolean,
  searchEnabled: boolean,
  environment: "production" | "test",
  productionEmbeddingProfileAttestation: NonNullable<
    PlatformConfig["infinityContext"]
  >["activation"]["productionEmbeddingProfileAttestation"] = null,
  sourceRevision: string =
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedProductionSemanticReleaseRevision,
): PlatformConfig {
  return {
    bindAddress: "127.0.0.1",
    discordApplicationId: botApplicationIdentity,
    discordBotikApplicationId: botApplicationIdentity,
    discordCraigApplicationId: "999999999999999999",
    discordFinalPublicationMode: "separate-message",
    discordPublicationMode: "message",
    infinityContext: {
      activation: {
        apiVersion: "v1",
        archiveSha256: INFINITY_CONTEXT_SDK_PROVENANCE.archiveSha256,
        environment,
        immutablePackageIntegrity: environment === "production"
          ? INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity
          : null,
        indexingEnabled,
        packageSource: environment === "production"
          ? "immutable_package"
          : "reviewed_source_workspace",
        productionEmbeddingProfileAttestation,
        qualificationManifestSha256: environment === "production"
          ? INFINITY_CONTEXT_SDK_PROVENANCE.retainedLiveQualificationManifestSha256
          : null,
        schemaVersion: 1,
        sdkCommit: INFINITY_CONTEXT_SDK_PROVENANCE.commit,
        sdkTree: INFINITY_CONTEXT_SDK_PROVENANCE.tree,
        searchEnabled,
        serviceName: "disposable-infinity-context",
        servingProfile: searchEnabled ? "same_room_retrieval" : "shadow_sync",
      },
      baseUrl,
      operationTimeoutMs: 120_000,
      requestTimeoutMs: 2_000,
    },
    liveIngressOwnerMode: "singleton",
    meetingKnowledge: {
      twoHourHistoricalQualification: {
        evidenceSha256: "e".repeat(64),
        releaseRevision: sourceRevision,
        rolloutEpoch: "synthetic-composition-test-r1",
        schemaVersion: 1,
      },
    },
    nodeEnvironment: environment,
    participantGreetingDefaultLocale: "en",
    participantGreetingProfiles: {},
    port: 4_310,
    recordingSpoolRoot: "/tmp/synthetic-meeting-knowledge-spool",
    s3: {
      bucket: "synthetic-only",
      endpoint: "http://127.0.0.1:1",
      prefix: "synthetic/",
      region: "us-east-1",
    },
    sourceRevision,
    secrets: {
      craigBearerToken: "synthetic-craig-token",
      discordToken: "synthetic-discord-token",
      infinityContextToken: "synthetic-infinity-token",
      infinityContextTopologyKey: "t".repeat(32),
      postgresUrl: "postgresql://synthetic.invalid/test",
      redisUrl: "redis://synthetic.invalid/0",
      s3AccessKeyId: "synthetic-access",
      s3SecretAccessKey: "synthetic-secret",
      subscriptionRuntimeToken: "synthetic-runtime-token",
    },
    speaches: {
      baseUrl: "http://127.0.0.1:1",
      model: "synthetic-model",
    },
    subscriptionRuntime: {
      address: "127.0.0.1:1",
      launcherSha256: "d".repeat(64),
    },
    transcriptionProvider: "speaches",
  };
}

export const silentLogger: Logger = {
  child: () => silentLogger,
  debug: () => { /* intentionally silent synthetic logger */ },
  error: () => { /* intentionally silent synthetic logger */ },
  flush: () => Promise.resolve(),
  info: () => { /* intentionally silent synthetic logger */ },
  warn: () => { /* intentionally silent synthetic logger */ },
};

export function allowOnlySyntheticRoom(): HistoricalAuthorizationPort {
  return {
    authorize: async (request) => ({
      authorizationDigest: `${request.scopeId}:${request.roomId}:synthetic-v1`,
      authorizationEpoch: "1",
      authorized: request.authorizationPrincipalRef === "synthetic-principal" &&
        request.scopeId === scopeId && request.roomId === roomId,
      policyVersion: "synthetic-room-policy.v1",
    }),
  };
}

export function historicalTwoHourMeeting(): Meeting {
  return recordedMeeting({
    actors: [
      { actorId: "human-history-a", kind: "human" },
      { actorId: "human-history-b", kind: "human" },
      { actorId: "botik-automation", kind: "automation" },
    ],
    meetingId: historicalMeetingId,
    turns: historicalTwoHourTurns(),
  });
}

export function currentMeeting(): Meeting {
  return recordedMeeting({
    actors: [{ actorId: "human-current", kind: "human" }],
    meetingId: currentMeetingId,
    turns: currentMeetingTurns(),
  });
}

function recordedMeeting(input: {
  readonly actors: readonly { readonly actorId: string; readonly kind: "automation" | "human" }[];
  readonly meetingId: string;
  readonly turns: readonly {
    readonly endMs: number;
    readonly speakerId: string;
    readonly startMs: number;
    readonly text: string;
    readonly turnId: string;
  }[];
}): Meeting {
  return Meeting.record({
    actors: input.actors,
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "e".repeat(40),
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingId: input.meetingId,
    publicationTargetId: resultsContainerId,
    recording: {
      manifestLocator: `s3://synthetic-only/${input.meetingId}/manifest.json`,
      recordingId: `recording-${input.meetingId}`,
      speakerAudio: input.actors.filter(({ kind }) => kind === "human")
        .map(({ actorId }) => ({
          audioLocator: `s3://synthetic-only/${input.meetingId}/${actorId}.flac`,
          speakerId: actorId,
          timelineOffsetMs: 0,
        })),
    },
    source: { roomId, scopeId },
  });
}

export async function persistPublishedMeeting(
  repository: PostgresMeetingRepository,
  meeting: Meeting,
): Promise<MeetingSnapshot> {
  await repository.save(meeting.toSnapshot(), 0);
  meeting.beginTranscription();
  const sourceTurns = meeting.meetingId === historicalMeetingId
    ? historicalTwoHourTurns()
    : currentMeetingTurns();
  const transcript = FinalTranscript.create({
    recordingId: meeting.recording.recordingId,
    transcriptId: `transcript-${meeting.meetingId}`,
    turns: sourceTurns,
    version: 1,
  });
  meeting.completeTranscription(transcript);
  const evidenceTurn = sourceTurns.find(({ speakerId }) =>
    meeting.actors?.some(({ actorId, kind }) =>
      actorId === speakerId && kind === "human"
    ) === true
  );
  if (evidenceTurn === undefined) {
    throw new Error("synthetic meeting contains no human evidence turn");
  }
  meeting.beginSummary();
  meeting.completeSummary(EvidenceBackedSummary.create({
    actionItems: [],
    decisions: [{
      decisionId: `decision-${meeting.meetingId}`,
      evidenceTurnIds: [evidenceTurn.turnId],
      text: "Use the accepted synthetic transcript for qualification.",
    }],
    openQuestions: [],
    overview: "Synthetic qualification summary.",
    summaryId: `summary-${meeting.meetingId}`,
    title: "Synthetic qualification",
    transcriptId: transcript.transcriptId,
    version: 1,
  }, transcript));
  meeting.beginPublication();
  meeting.completePublication({
    externalPublicationId:
      `discord:v2:channel:${resultsContainerId}:message:${meeting.meetingId}`,
    idempotencyKey: meeting.publicationIdempotencyKey(),
  });
  const snapshot = meeting.toSnapshot();
  await repository.save(snapshot, 0);
  return snapshot;
}

function historicalTwoHourTurns() {
  const turns = Array.from({ length: 720 }, (_, position) => {
    const needle = positionalNeedles.find((candidate) =>
      candidate.position === position
    );
    const startMs = position * 10_000;
    return {
      endMs: startMs + 10_000,
      speakerId: position % 2 === 0 ? "human-history-a" : "human-history-b",
      startMs,
      text: positionalText(position, needle?.marker),
      turnId: `history-turn-${position.toString().padStart(4, "0")}`,
    };
  });
  turns.push({
    endMs: 7_201_000,
    speakerId: "botik-automation",
    startMs: 7_200_000,
    text: "BOTIK INTERIM TRANSCRIPT MUST NEVER BE INDEXED",
    turnId: "botik-derived-turn",
  });
  return turns;
}

function positionalText(position: number, marker: string | undefined): string {
  if (marker !== undefined) {
    if (position === 360) {
      return `Средняя русская контрольная точка ${marker}; исправленный факт.`;
    }
    if (position === 540) {
      return `Трёхчетвертная отметка ${marker}; linked to ORCHID-ALPHA.`;
    }
    if (position === 648) {
      return `Correction ${marker}: Monday replaces Friday for the release.`;
    }
    return `Positional evidence ${marker} at synthetic segment ${position}.`;
  }
  if (position % 3 === 0) {
    return `Routine English planning segment ${position}; corrected synthetic noise.`;
  }
  return position % 3 === 1
    ? `Обычное русское обсуждение ${position}; только финальная реплика.`
    : `Mixed planning сегмент ${position}; accepted human transcript.`;
}

function currentMeetingTurns() {
  return Array.from({ length: 16 }, (_, position) => ({
    endMs: (position + 1) * 10_000,
    speakerId: "human-current",
    startMs: position * 10_000,
    text: position === 8
      ? "CURRENT-ANCHOR confirms Project Atlas is active and connects to PINE-GOLF."
      : `Current accepted planning detail ${position}.`,
    turnId: `current-turn-${position.toString().padStart(2, "0")}`,
  }));
}

export function correctedHistoricalSnapshot(
  snapshot: MeetingSnapshot,
): MeetingSnapshot {
  if (snapshot.transcript === null) {
    throw new Error("synthetic historical snapshot has no transcript");
  }
  return Meeting.restore({
    ...snapshot,
    revision: snapshot.revision + 1,
    transcript: {
      ...snapshot.transcript,
      turns: snapshot.transcript.turns.map((turn) =>
        turn.turnId === "history-turn-0719"
          ? { ...turn, text: "Correction PINE-GOLF-V2: Tuesday is the accepted final date." }
          : turn
      ),
      version: 2,
    },
  }).toSnapshot();
}

export function humanActorsFor(
  turns: readonly RehydratedEvidenceTurn[],
  anchorActors: readonly string[],
): readonly string[] {
  return Object.freeze([...new Set([
    ...anchorActors,
    ...turns.map(({ speakerId }) => speakerId),
  ])].toSorted());
}

export async function historicalRows(pool: Pool): Promise<readonly {
  readonly meeting_id: string;
  readonly state: string;
}[]> {
  const result = await pool.query<{ readonly meeting_id: string; readonly state: string }>(
    `SELECT meeting_id, state FROM meeting_core.historical_memory_sync ORDER BY meeting_id, desired_generation`,
  );
  return result.rows;
}

export async function checkpointAttempts(pool: Pool): Promise<readonly number[]> {
  const result = await pool.query<{ readonly attempt_count: number }>(
    `SELECT attempt_count::integer AS attempt_count FROM meeting_core.historical_coverage_checkpoints ORDER BY checkpoint_id`,
  );
  return result.rows.map(({ attempt_count }) => attempt_count);
}
