import { z } from "zod";

import {
  processingEvidenceSchema,
  conversationLifecycleEvidenceSchema,
  type ConversationLifecycleEvidence,
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
const playbackReceiptLogBaseSchema = z.object({
  meetingId: z.string(),
  playbackAttemptId: z.string().trim().min(1),
  playbackKind: z.enum(["answer", "prepared-cue", "thinking-cue"]),
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

export function parseConversationLifecycleEvidenceLogs(
  output: string,
  meetingId: string,
): ConversationLifecycleEvidence {
  const events: ConversationLifecycleEvidence["events"][number][] = [];
  const playbackReceipts: ConversationLifecycleEvidence["playbackReceipts"][number][] = [];
  for (const line of output.split("\n")) {
    const event = parseJsonLine(line);
    if (event === undefined || event.meetingId !== meetingId) {
      continue;
    }
    const playbackStarted = playbackStartedLogSchema.safeParse(event);
    if (playbackStarted.success) {
      playbackReceipts.push({
        observedAt: playbackStarted.data.time,
        playbackAttemptId: playbackStarted.data.playbackAttemptId,
        playbackKind: playbackStarted.data.playbackKind,
        playbackStartedAtEpochMs: playbackStarted.data.playbackStartedAtEpochMs,
        playbackStartedAtMonotonicMs:
          playbackStarted.data.playbackStartedAtMonotonicMs,
        status: "started",
        turnId: playbackStarted.data.turnId,
      });
      continue;
    }
    const playbackFinished = playbackFinishedLogSchema.safeParse(event);
    if (playbackFinished.success) {
      playbackReceipts.push({
        observedAt: playbackFinished.data.time,
        playbackAttemptId: playbackFinished.data.playbackAttemptId,
        playbackFinishedAtEpochMs: playbackFinished.data.playbackFinishedAtEpochMs,
        playbackFinishedAtMonotonicMs:
          playbackFinished.data.playbackFinishedAtMonotonicMs,
        playbackKind: playbackFinished.data.playbackKind,
        status: "finished",
        turnId: playbackFinished.data.turnId,
      });
      continue;
    }
    const playbackSettled = playbackSettledLogSchema.safeParse(event);
    if (playbackSettled.success) {
      playbackReceipts.push({
        observedAt: playbackSettled.data.time,
        playbackAttemptId: playbackSettled.data.playbackAttemptId,
        playbackKind: playbackSettled.data.playbackKind,
        playbackSettledAtEpochMs: playbackSettled.data.playbackSettledAtEpochMs,
        playbackSettledAtMonotonicMs:
          playbackSettled.data.playbackSettledAtMonotonicMs,
        settlement: playbackSettled.data.settlement,
        status: "settled",
        turnId: playbackSettled.data.turnId,
      });
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
  return conversationLifecycleEvidenceSchema.parse({ events, playbackReceipts });
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
