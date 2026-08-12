import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  conversationVoiceEvidenceV3Schema,
  supplementalPlaybackEvidenceV1Schema,
} from "./conversation-retained-evidence-schema.js";
import { unboundActorRunEvidenceV1Schema } from "./e2e-evidence-schema.js";
import { liveDiscordPlaybackLinkProofSchema } from "./live-discord-playback-link-observer.js";
import { recordingReadyReceiptV1Schema } from "./recording-ready-receipt.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const outputPath = z.string().refine((value) => isAbsolute(value) && value !== "/");
const scenario = z.enum(["sequential", "overlap", "reconnect"]);

const completionSchemas = {
  actor: z.object({
    kind: z.literal("actor-completion"), outputPath, runId: identifier,
    scenario, status: z.literal("completed"),
  }).strict(),
  "conversation-observer": z.object({
    kind: z.literal("conversation-observer-completion"),
    outputPaths: z.array(outputPath).min(1).max(6), runId: identifier,
    status: z.literal("completed"),
  }).strict().refine(({ outputPaths }) => new Set(outputPaths).size === outputPaths.length, {
    message: "Conversation observer completion output paths must be unique",
  }),
  "playback-link-observer": z.object({
    kind: z.literal("playback-link-observer-completion"), messageId: identifier,
    outputPath, recordingId: identifier, runId: identifier, status: z.literal("captured"),
  }).strict(),
  "recording-ready": z.object({
    kind: z.literal("recording-ready-completion"), outputPath,
    recordingId: identifier, runId: identifier, status: z.literal("ready"),
  }).strict(),
  "supplemental-player": z.object({
    kind: z.literal("supplemental-player-completion"), outputPath,
    runId: identifier, status: z.literal("completed"),
  }).strict(),
} as const;

export type HostedFiniteProcessCompletionKind = keyof typeof completionSchemas;

export type HostedFiniteProcessCompletionExpectation =
  | { readonly kind: "actor"; readonly outputPath: string; readonly runId: string; readonly scenario: z.infer<typeof scenario> }
  | { readonly kind: "conversation-observer"; readonly outputPaths: readonly string[]; readonly runId: string }
  | { readonly kind: "playback-link-observer"; readonly outputPath: string; readonly recordingId?: string; readonly runId: string }
  | { readonly kind: "recording-ready"; readonly outputPath: string; readonly runId: string }
  | { readonly kind: "supplemental-player"; readonly outputPath: string; readonly runId: string };

export async function verifyHostedFiniteProcessCompletion(
  stdout: string,
  expected: HostedFiniteProcessCompletionExpectation,
): Promise<unknown> {
  const output = parseLastJsonLine(stdout);
  if (expected.kind === "actor") {
    const completion = completionSchemas.actor.parse(output);
    assertEqual(completion.outputPath, expected.outputPath, "actor output path");
    assertEqual(completion.runId, expected.runId, "actor run ID");
    assertEqual(completion.scenario, expected.scenario, "actor scenario");
    const artifact = unboundActorRunEvidenceV1Schema.parse(await readJson(expected.outputPath));
    assertEqual(artifact.runId, expected.runId, "actor artifact run ID");
    assertEqual(artifact.scenario, expected.scenario, "actor artifact scenario");
    return artifact;
  }
  if (expected.kind === "conversation-observer") {
    const completion = completionSchemas["conversation-observer"].parse(output);
    assertStringArrayEqual(completion.outputPaths, expected.outputPaths, "conversation observer output paths");
    assertEqual(completion.runId, expected.runId, "conversation observer run ID");
    const artifacts = await Promise.all(expected.outputPaths.map(async (path) =>
      conversationVoiceEvidenceV3Schema.parse(await readJson(path))
    ));
    for (const artifact of artifacts) {
      assertEqual(artifact.runId, expected.runId, "conversation observer artifact run ID");
    }
    return artifacts;
  }
  if (expected.kind === "playback-link-observer") {
    const completion = completionSchemas["playback-link-observer"].parse(output);
    assertEqual(completion.outputPath, expected.outputPath, "playback-link output path");
    if (expected.recordingId !== undefined) {
      assertEqual(completion.recordingId, expected.recordingId, "playback-link recording ID");
    }
    assertEqual(completion.runId, expected.runId, "playback-link run ID");
    const artifact = liveDiscordPlaybackLinkProofSchema.parse(await readJson(expected.outputPath));
    assertEqual(artifact.messageId, completion.messageId, "playback-link message ID");
    assertEqual(artifact.recordingId, completion.recordingId, "playback-link artifact recording ID");
    assertEqual(artifact.runId, expected.runId, "playback-link artifact run ID");
    return artifact;
  }
  if (expected.kind === "recording-ready") {
    const completion = completionSchemas["recording-ready"].parse(output);
    assertEqual(completion.outputPath, expected.outputPath, "recording-ready output path");
    assertEqual(completion.runId, expected.runId, "recording-ready run ID");
    const artifact = recordingReadyReceiptV1Schema.parse(await readJson(expected.outputPath));
    assertEqual(artifact.recordingId, completion.recordingId, "recording-ready recording ID");
    assertEqual(artifact.runId, expected.runId, "recording-ready artifact run ID");
    return artifact;
  }
  const completion = completionSchemas["supplemental-player"].parse(output);
  assertEqual(completion.outputPath, expected.outputPath, "supplemental output path");
  assertEqual(completion.runId, expected.runId, "supplemental run ID");
  const artifact = supplementalPlaybackEvidenceV1Schema.parse(await readJson(expected.outputPath));
  assertEqual(artifact.runId, expected.runId, "supplemental artifact run ID");
  return artifact;
}

function parseLastJsonLine(stdout: string): unknown {
  const line = stdout.trimEnd().split("\n").at(-1);
  if (line === undefined || line.trim().length === 0) {
    throw new Error("Hosted finite process produced no completion output");
  }
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error("Hosted finite process produced malformed completion output");
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function assertEqual(actual: unknown, expected: unknown, coordinate: string): void {
  if (actual !== expected) {
    throw new Error(`Hosted finite process ${coordinate} correlation mismatch`);
  }
}

function assertStringArrayEqual(actual: readonly string[], expected: readonly string[], coordinate: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`Hosted finite process ${coordinate} correlation mismatch`);
  }
}
