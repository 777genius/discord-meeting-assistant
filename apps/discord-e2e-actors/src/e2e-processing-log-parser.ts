import { z } from "zod";

import {
  processingEvidenceSchema,
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
