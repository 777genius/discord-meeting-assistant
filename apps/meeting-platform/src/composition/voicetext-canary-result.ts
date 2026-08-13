import { createHash } from "node:crypto";

import type { VoicetextBatchTaskResult } from "@discord-meeting/voicetext-adapter";

export interface VoicetextCanarySegment {
  readonly endMs: number;
  readonly startMs: number;
  readonly text: string;
}

export interface VoicetextCanaryBatchIdentity {
  readonly jobId: string;
  readonly resultId: string;
  readonly resultSha256: string;
}

export function voicetextCanaryBatchSegments(
  task: Extract<VoicetextBatchTaskResult, { kind: "completed" }>,
): readonly VoicetextCanarySegment[] {
  const source = task.result.readableSegments.length > 0
    ? task.result.readableSegments.map(({ endSeconds, startSeconds, transcript }) => ({
        endMs: milliseconds(endSeconds), startMs: milliseconds(startSeconds), text: transcript.trim(),
      }))
    : task.result.utterances.map(({ endSeconds, startSeconds, transcript }) => ({
        endMs: milliseconds(endSeconds), startMs: milliseconds(startSeconds), text: transcript.trim(),
      }));
  const segments = source.filter(({ text }) => text.length > 0);
  if (segments.length === 0 || segments.length > 1_024) {
    throw new Error("Voicetext batch canary returned no bounded semantic segments");
  }
  return segments;
}

export function voicetextCanaryBatchIdentity(
  task: Extract<VoicetextBatchTaskResult, { kind: "completed" }>,
  segments: readonly VoicetextCanarySegment[],
): VoicetextCanaryBatchIdentity {
  const resultSha256 = digestCanonical(segments);
  return { jobId: task.jobId, resultId: `sha256:${digestCanonical(task.result)}`, resultSha256 };
}

function milliseconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1_000));
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonicalize);}
  if (typeof value !== "object" || value === null) {return value;}
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalize(nested)]));
}
