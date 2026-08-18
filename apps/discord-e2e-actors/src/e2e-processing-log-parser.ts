import { z } from "zod";

import {
  collectedConversationLifecycleEvidenceSchema,
  processingEvidenceSchema,
  type CollectedConversationLifecycleEvidence,
  type ProcessingEvidence,
} from "./e2e-evidence-schema.js";

const stageLogSchema = z.object({
  durationMilliseconds: z.number().nonnegative(),
  meetingId: z.string(),
  message: z.literal("Meeting processing stage completed"),
  outcome: z.literal("succeeded"),
  stage: z.enum(["publication", "summary", "transcription"]),
  time: z.iso.datetime(),
}).loose();

const runtimeLogSchema = z.object({
  durationMs: z.number().nonnegative(),
  meetingId: z.string(),
  message: z.literal("Subscription runtime task completed"),
  model: z.string().trim().min(1),
  outputSchemaName: z.string().trim().min(1),
  policyVersion: z.string().trim().min(1),
  purpose: z.literal("discord_meeting.summary.generate"),
  reasoningEffort: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  status: z.literal("completed"),
  time: z.iso.datetime(),
}).loose();

const greetingPlaybackLogSchema = z.object({
  greetingLocale: z.enum(["en", "ru"]),
  meetingId: z.string(),
  message: z.literal("Participant greeting playback settled"),
  participantId: z.string().trim().min(1),
  participantNameStatus: z.enum(["known", "unknown"]),
  time: z.iso.datetime(),
  turnId: z.string().trim().min(1),
}).loose();

const farewellPlaybackLogSchema = z.object({
  evidenceTurnIds: z.array(z.string().trim().min(1)).min(1),
  locale: z.enum(["en", "ru"]),
  meetingId: z.string(),
  message: z.literal("Meeting farewell playback settled"),
  playbackAttemptId: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  time: z.iso.datetime(),
  turnId: z.literal("meeting-farewell:v1"),
}).loose();
const addressedAnswerLogSchema = z.object({
  meetingId: z.string(),
  message: z.literal("Live conversation turn observed"),
  outcome: z.enum(["active", "queued"]),
  speakerId: z.string().trim().min(1),
  time: z.iso.datetime(),
  turnId: z.string().trim().min(1),
}).loose();
const ttsAttestationSchema = z.object({
  attemptId: z.string().trim().min(1),
  deployment: z.string().trim().min(1),
  keyId: z.string().regex(/^[a-f\d]{64}$/u),
  model: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  schemaVersion: z.literal(1),
  signature: z.string().regex(/^[a-f\d]{64}$/u),
  sourceRevision: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  voice: z.string().trim().min(1),
  voiceProfileId: z.string().trim().min(1),
}).strict();
const playbackReceiptLogBaseSchema = z.object({
  meetingId: z.string(),
  playbackAttemptId: z.string().trim().min(1),
  playbackKind: z.enum(["answer", "prepared-cue", "thinking-cue"]),
  preparedAssetSha256: z.string().regex(/^[a-f\d]{64}$/u).optional(),
  speechProvenance: z.enum(["literal_tts", "model_tts"]).optional(),
  ttsAttestation: ttsAttestationSchema.optional(),
  thinkingCuePcmSha256: z.string().regex(/^[a-f\d]{64}$/u).optional(),
  time: z.iso.datetime(),
  turnId: z.string().trim().min(1),
});
const playbackStartedLogSchema = playbackReceiptLogBaseSchema.extend({
  message: z.literal("Conversation playback started"),
  playbackStartedAtEpochMs: z.number().int().positive(),
  playbackStartedAtMonotonicMs: z.number().nonnegative(),
}).loose();
const playbackFinishedLogSchema = playbackReceiptLogBaseSchema.extend({
  message: z.literal("Conversation playback finished"),
  playbackFinishedAtEpochMs: z.number().int().positive(),
  playbackFinishedAtMonotonicMs: z.number().nonnegative(),
}).loose();
const playbackSettledLogSchema = playbackReceiptLogBaseSchema.extend({
  message: z.literal("Conversation playback settled"),
  playbackSettledAtEpochMs: z.number().int().positive(),
  playbackSettledAtMonotonicMs: z.number().nonnegative(),
  settlement: z.enum(["played", "unplayed", "partial", "unknown"]),
}).loose();
const participantLifecycleLogSchema = z.object({
  eventType: z.enum(["participant.joined", "participant.left"]),
  meetingId: z.string(),
  message: z.literal("Live participant lifecycle accepted"),
  occurredAt: z.iso.datetime(),
  participantId: z.string().trim().min(1),
  time: z.iso.datetime(),
}).loose();
const groundedAnswerValidatedLogSchema = z.object({
  citationTurnIds: z.array(z.string().trim().min(1)).min(1).max(32),
  evidenceEpoch: z.string().trim().min(1),
  knowledgeEpoch: z.string().trim().min(1),
  meetingId: z.string(),
  message: z.literal("Grounded knowledge answer validated"),
  participantId: z.string().trim().min(1),
  playbackProvenance: z.enum(["literal_tts", "model_tts"]),
  status: z.literal("validated"),
  time: z.iso.datetime(),
  turnId: z.string().trim().min(1),
}).loose();
const groundedAnswerCancelledLogSchema = z.object({
  meetingId: z.string(),
  message: z.literal("Grounded knowledge answer cancelled"),
  reason: z.enum([
    "barge-in", "disconnected", "meeting-ended", "playback-failed",
    "runtime-shutdown", "superseded",
  ]),
  status: z.literal("cancelled"),
  time: z.iso.datetime(),
  turnId: z.string().trim().min(1),
}).loose();
const groundedCancellationPcmFenceLogSchema = z.object({
  acceptedPacketCountAfterCancellation: z.literal(0),
  attemptId: z.string().trim().min(1),
  cancellationObservedAt: z.iso.datetime(),
  fenceObservedAt: z.iso.datetime(),
  meetingId: z.string(),
  message: z.literal("Craig authoritative cancellation PCM fence observed"),
  recordingId: z.string().trim().min(1),
  source: z.literal("craig-authoritative-playback-track"),
  trackSha256: z.string().regex(/^[a-f\d]{64}$/u),
  turnId: z.string().trim().min(1),
}).loose();

export function parseProcessingEvidenceLogs(output: string, meetingId: string): ProcessingEvidence {
  const stages: ProcessingEvidence["stages"][number][] = [];
  const summaryRuntimeExecutions: ProcessingEvidence["summaryRuntimeExecutions"][number][] = [];
  for (const line of output.split("\n")) {
    const event = parseJsonLine(line);
    if (event === undefined || event.meetingId !== meetingId) {
      continue;
    }
    const stage = stageLogSchema.safeParse(event);
    if (stage.success) {
      stages.push({
        durationMs: Math.round(stage.data.durationMilliseconds),
        observedAt: stage.data.time,
        outcome: stage.data.outcome,
        stage: stage.data.stage,
      });
      continue;
    }
    const runtime = runtimeLogSchema.safeParse(event);
    if (runtime.success) {
      summaryRuntimeExecutions.push({
        durationMs: Math.round(runtime.data.durationMs),
        model: runtime.data.model,
        observedAt: runtime.data.time,
        outputSchemaName: runtime.data.outputSchemaName,
        policyVersion: runtime.data.policyVersion,
        purpose: runtime.data.purpose,
        reasoningEffort: runtime.data.reasoningEffort,
        runId: runtime.data.runId,
        status: runtime.data.status,
      });
    }
  }
  return processingEvidenceSchema.parse({ stages, summaryRuntimeExecutions });
}

type PlaybackReceipt =
  CollectedConversationLifecycleEvidence["playbackReceipts"][number];

interface PlaybackReceiptMetadataInput {
  readonly playbackAttemptId: string;
  readonly playbackKind: PlaybackReceipt["playbackKind"];
  readonly preparedAssetSha256?: string | undefined;
  readonly speechProvenance?: "literal_tts" | "model_tts" | undefined;
  readonly thinkingCuePcmSha256?: string | undefined;
  readonly ttsAttestation?: {
    readonly attemptId: string;
    readonly deployment: string;
    readonly keyId: string;
    readonly model: string;
    readonly provider: string;
    readonly schemaVersion: 1;
    readonly signature: string;
    readonly sourceRevision: string;
    readonly turnId: string;
    readonly voice: string;
    readonly voiceProfileId: string;
  } | undefined;
  readonly time: string;
  readonly turnId: string;
}

function playbackReceiptMetadata(
  input: PlaybackReceiptMetadataInput,
): Pick<
  PlaybackReceipt,
  | "observedAt"
  | "playbackAttemptId"
  | "playbackKind"
  | "preparedAssetSha256"
  | "speechProvenance"
  | "thinkingCuePcmSha256"
  | "ttsAttestation"
  | "turnId"
> {
  return {
    observedAt: input.time,
    playbackAttemptId: input.playbackAttemptId,
    playbackKind: input.playbackKind,
    ...(input.preparedAssetSha256 === undefined
      ? {}
      : { preparedAssetSha256: input.preparedAssetSha256 }),
    ...(input.speechProvenance === undefined
      ? {}
      : { speechProvenance: input.speechProvenance }),
    ...(input.ttsAttestation === undefined
      ? {}
      : { ttsAttestation: input.ttsAttestation }),
    ...(input.thinkingCuePcmSha256 === undefined
      ? {}
      : { thinkingCuePcmSha256: input.thinkingCuePcmSha256 }),
    turnId: input.turnId,
  };
}

function parsePlaybackReceipt(
  event: Record<string, unknown>,
): PlaybackReceipt | undefined {
  const started = playbackStartedLogSchema.safeParse(event);
  if (started.success) {
    return {
      ...playbackReceiptMetadata(started.data),
      playbackStartedAtEpochMs: started.data.playbackStartedAtEpochMs,
      playbackStartedAtMonotonicMs: started.data.playbackStartedAtMonotonicMs,
      status: "started",
    };
  }
  const finished = playbackFinishedLogSchema.safeParse(event);
  if (finished.success) {
    return {
      ...playbackReceiptMetadata(finished.data),
      playbackFinishedAtEpochMs: finished.data.playbackFinishedAtEpochMs,
      playbackFinishedAtMonotonicMs: finished.data.playbackFinishedAtMonotonicMs,
      status: "finished",
    };
  }
  const settled = playbackSettledLogSchema.safeParse(event);
  if (settled.success) {
    return {
      ...playbackReceiptMetadata(settled.data),
      playbackSettledAtEpochMs: settled.data.playbackSettledAtEpochMs,
      playbackSettledAtMonotonicMs: settled.data.playbackSettledAtMonotonicMs,
      settlement: settled.data.settlement,
      status: "settled",
    };
  }
  return undefined;
}

export function parseConversationLifecycleEvidenceLogs(
  output: string,
  meetingId: string,
): CollectedConversationLifecycleEvidence {
  const events: CollectedConversationLifecycleEvidence["events"][number][] = [];
  const cancellationPcmProofs:
    CollectedConversationLifecycleEvidence["cancellationPcmProofs"][number][] = [];
  const groundedAnswers: CollectedConversationLifecycleEvidence["groundedAnswers"][number][] = [];
  const playbackReceipts: CollectedConversationLifecycleEvidence["playbackReceipts"][number][] = [];
  const participantLifecycleReceipts: CollectedConversationLifecycleEvidence["participantLifecycleReceipts"][number][] = [];
  for (const line of output.split("\n")) {
    const event = parseJsonLine(line);
    if (event === undefined || event.meetingId !== meetingId) {
      continue;
    }
    const participantLifecycle = participantLifecycleLogSchema.safeParse(event);
    if (participantLifecycle.success) {
      participantLifecycleReceipts.push({
        eventType: participantLifecycle.data.eventType,
        observedAt: participantLifecycle.data.time,
        occurredAt: participantLifecycle.data.occurredAt,
        participantId: participantLifecycle.data.participantId,
        type: "participant-lifecycle",
      });
      continue;
    }
    const cancellationPcmFence = groundedCancellationPcmFenceLogSchema.safeParse(event);
    if (cancellationPcmFence.success) {
      cancellationPcmProofs.push({
        acceptedPacketCountAfterCancellation: 0,
        attemptId: cancellationPcmFence.data.attemptId,
        cancellationObservedAt: cancellationPcmFence.data.cancellationObservedAt,
        fenceObservedAt: cancellationPcmFence.data.fenceObservedAt,
        recordingId: cancellationPcmFence.data.recordingId,
        source: cancellationPcmFence.data.source,
        trackSha256: cancellationPcmFence.data.trackSha256,
        turnId: cancellationPcmFence.data.turnId,
      });
      continue;
    }
    const groundedValidated = groundedAnswerValidatedLogSchema.safeParse(event);
    if (groundedValidated.success) {
      groundedAnswers.push({
        citationTurnIds: groundedValidated.data.citationTurnIds,
        evidenceEpoch: groundedValidated.data.evidenceEpoch,
        knowledgeEpoch: groundedValidated.data.knowledgeEpoch,
        observedAt: groundedValidated.data.time,
        participantId: groundedValidated.data.participantId,
        playbackProvenance: groundedValidated.data.playbackProvenance,
        status: groundedValidated.data.status,
        turnId: groundedValidated.data.turnId,
      });
      continue;
    }
    const groundedCancelled = groundedAnswerCancelledLogSchema.safeParse(event);
    if (groundedCancelled.success) {
      groundedAnswers.push({
        observedAt: groundedCancelled.data.time,
        reason: groundedCancelled.data.reason,
        status: groundedCancelled.data.status,
        turnId: groundedCancelled.data.turnId,
      });
      continue;
    }
    const playbackReceipt = parsePlaybackReceipt(event);
    if (playbackReceipt !== undefined) {
      playbackReceipts.push(playbackReceipt);
      continue;
    }
    const addressed = addressedAnswerLogSchema.safeParse(event);
    if (addressed.success) {
      events.push({
        observedAt: addressed.data.time,
        outcome: addressed.data.outcome,
        participantId: addressed.data.speakerId,
        turnId: addressed.data.turnId,
        type: "addressed-answer",
      });
      continue;
    }
    const greeting = greetingPlaybackLogSchema.safeParse(event);
    if (greeting.success) {
      events.push({
        greetingLocale: greeting.data.greetingLocale,
        observedAt: greeting.data.time,
        participantId: greeting.data.participantId,
        participantNameStatus: greeting.data.participantNameStatus,
        turnId: greeting.data.turnId,
        type: "greeting",
      });
      continue;
    }
    const farewell = farewellPlaybackLogSchema.safeParse(event);
    if (farewell.success) {
      events.push({
        evidenceTurnIds: farewell.data.evidenceTurnIds,
        locale: farewell.data.locale,
        observedAt: farewell.data.time,
        playbackAttemptId: farewell.data.playbackAttemptId,
        reason: farewell.data.reason,
        turnId: farewell.data.turnId,
        type: "farewell",
      });
    }
  }
  return collectedConversationLifecycleEvidenceSchema.parse({
    cancellationPcmProofs,
    events,
    groundedAnswers,
    participantLifecycleReceipts,
    playbackReceipts,
  });
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  if (line.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
