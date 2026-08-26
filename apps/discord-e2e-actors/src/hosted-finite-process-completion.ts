import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  conversationVoiceEvidenceV3Schema,
  supplementalPlaybackEvidenceV1Schema,
} from "./conversation-retained-evidence-schema.js";
import { fixtureManifestV1Schema, unboundActorRunEvidenceV1Schema } from "./e2e-evidence-schema.js";
import { liveDiscordPlaybackLinkProofSchema } from "./live-discord-playback-link-observer.js";
import { recordingReadyReceiptSchema } from "./recording-ready-receipt.js";
import { greetingLedgerQualificationV1Schema } from "./greeting-ledger-qualification.js";
import { lateGreetingObservationV1Schema } from "./late-greeting-observation.js";
import {
  historicalReplyCampaignEvidenceV1Schema,
  historicalReplyCampaignInputV1Schema,
} from "./historical-reply-campaign-contract.js";
import { finalizedLiveMemoryQualificationV1Schema } from "./finalized-live-memory-qualification.js";
import { thinRemediationProofV1Schema } from "./thin-remediation-proof.js";
import { privateCampaignCoverageQualificationV1Schema } from
  "./private-campaign-coverage-qualification.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const outputPath = z.string().refine((value) => isAbsolute(value) && value !== "/");
const scenario = z.enum(["sequential", "overlap", "reconnect"]);
const maximumCompletionArtifactBytes = 32 * 1024 * 1024;

const completionSchemas = {
  actor: z.object({
    kind: z.literal("actor-completion"), outputPath, runId: identifier,
    scenario, status: z.literal("completed"),
  }).strict(),
  "conversation-observer": z.object({
    kind: z.literal("conversation-observer-completion"),
    outputPaths: z.array(outputPath).min(1).max(7), runId: identifier,
    status: z.literal("completed"),
  }).strict().refine(({ outputPaths }) => new Set(outputPaths).size === outputPaths.length, {
    message: "Conversation observer completion output paths must be unique",
  }),
  "greeting-ledger-observer": z.object({
    kind: z.literal("greeting-ledger-observer-completion"), outputPath,
    runId: identifier, status: z.literal("completed"),
  }).strict(),
  "historical-reply-observer": z.object({
    kind: z.literal("historical-reply-observer-completion"), outputPath,
    runId: identifier, status: z.literal("completed"),
  }).strict(),
  "historical-reply-preparer": z.object({
    kind: z.literal("historical-reply-preparer-completion"), outputPath,
    runId: identifier, status: z.literal("completed"),
  }).strict(),
  "live-memory-observer": z.object({
    kind: z.literal("live-memory-observer-completion"), outputPath,
    runId: identifier, status: z.literal("completed"),
  }).strict(),
  "private-coverage-observer": z.object({
    kind: z.literal("private-coverage-observer-completion"), outputPath,
    runId: identifier, status: z.literal("completed"),
  }).strict(),
  "remediation-bundle": z.object({
    kind: z.literal("remediation-bundle-completion"), outputPath,
    runId: identifier, status: z.literal("completed"),
  }).strict(),
  "playback-link-observer": z.object({
    kind: z.literal("playback-link-observer-completion"), messageId: identifier,
    outputPath, recordingId: identifier, runId: identifier, status: z.literal("captured"),
  }).strict(),
  "recording-ready": z.object({
    kind: z.literal("recording-ready-completion"), outputPath,
    recordingId: identifier, runId: identifier, status: z.literal("ready"),
  }).strict(),
  "replay-attestation-publisher": z.object({
    containerId: z.string().regex(/^[a-f\d]{64}$/u), fixtureSetId: identifier,
    imageId: z.string().regex(/^sha256:[a-f\d]{64}$/u), kind: z.literal("replay-attestation-publisher-completion"),
    recordingId: identifier, remoteAttestationPath: outputPath, runId: identifier,
    sourceRevision: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u), status: z.literal("ready"),
  }).strict(),
  "supplemental-player": z.object({
    kind: z.literal("supplemental-player-completion"), outputPath,
    runId: identifier, status: z.literal("completed"),
  }).strict(),
} as const;

export type HostedFiniteProcessCompletionExpectation =
  | { readonly kind: "actor"; readonly outputPath: string; readonly runId: string; readonly scenario: z.infer<typeof scenario> }
  | { readonly kind: "conversation-observer"; readonly outputPaths: readonly string[]; readonly runId: string }
  | { readonly kind: "greeting-ledger-observer"; readonly outputPath: string; readonly runId: string }
  | { readonly kind: "historical-reply-observer"; readonly outputPath: string; readonly runId: string }
  | { readonly kind: "historical-reply-preparer"; readonly outputPath: string; readonly runId: string }
  | { readonly kind: "live-memory-observer"; readonly outputPath: string; readonly runId: string }
  | { readonly kind: "private-coverage-observer"; readonly outputPath: string; readonly runId: string }
  | { readonly kind: "remediation-bundle"; readonly outputPath: string; readonly runId: string }
  | { readonly kind: "playback-link-observer"; readonly outputPath: string; readonly recordingId?: string; readonly runId: string }
  | { readonly kind: "recording-ready"; readonly outputPath: string; readonly runId: string }
  | { readonly fixtureManifestPath: string; readonly kind: "replay-attestation-publisher"; readonly recordingId?: string; readonly remoteAttestationPath: string; readonly runId: string }
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
    const voicePaths = expected.outputPaths.slice(0, 6);
    const artifacts = await Promise.all(voicePaths.map(async (path) =>
      conversationVoiceEvidenceV3Schema.parse(await readJson(path))
    ));
    for (const artifact of artifacts) {
      assertEqual(artifact.runId, expected.runId, "conversation observer artifact run ID");
    }
    const latePath = expected.outputPaths[6];
    const late = latePath === undefined ? undefined
      : lateGreetingObservationV1Schema.parse(await readJson(latePath));
    if (late !== undefined) { assertEqual(late.runId, expected.runId, "late greeting artifact run ID"); }
    return late === undefined ? artifacts : [...artifacts, late];
  }
  if (expected.kind === "greeting-ledger-observer") {
    const completion = completionSchemas["greeting-ledger-observer"].parse(output);
    assertEqual(completion.outputPath, expected.outputPath, "greeting ledger output path");
    assertEqual(completion.runId, expected.runId, "greeting ledger run ID");
    const artifact = greetingLedgerQualificationV1Schema.parse(await readJson(expected.outputPath));
    assertEqual(artifact.runId, expected.runId, "greeting ledger artifact run ID");
    return artifact;
  }
  if (expected.kind === "historical-reply-observer") {
    const completion = completionSchemas["historical-reply-observer"].parse(output);
    assertEqual(completion.outputPath, expected.outputPath, "historical reply output path");
    assertEqual(completion.runId, expected.runId, "historical reply run ID");
    const artifact = historicalReplyCampaignEvidenceV1Schema.parse(await readJson(expected.outputPath));
    assertEqual(artifact.campaign.runId, expected.runId, "historical reply artifact run ID");
    return artifact;
  }
  if (expected.kind === "historical-reply-preparer") {
    const completion = completionSchemas["historical-reply-preparer"].parse(output);
    assertEqual(completion.outputPath, expected.outputPath, "historical reply input output path");
    assertEqual(completion.runId, expected.runId, "historical reply preparer run ID");
    const artifact = historicalReplyCampaignInputV1Schema.parse(await readJson(expected.outputPath));
    assertEqual(artifact.runId, expected.runId, "historical reply input run ID");
    return artifact;
  }
  if (expected.kind === "live-memory-observer") {
    const completion = completionSchemas["live-memory-observer"].parse(output);
    assertEqual(completion.outputPath, expected.outputPath, "live memory output path");
    assertEqual(completion.runId, expected.runId, "live memory run ID");
    const artifact = finalizedLiveMemoryQualificationV1Schema.parse(await readJson(expected.outputPath));
    assertEqual(artifact.runId, expected.runId, "live memory artifact run ID");
    return artifact;
  }
  if (expected.kind === "private-coverage-observer") {
    const completion = completionSchemas["private-coverage-observer"].parse(output);
    assertEqual(completion.outputPath, expected.outputPath, "private coverage output path");
    assertEqual(completion.runId, expected.runId, "private coverage run ID");
    const artifact = privateCampaignCoverageQualificationV1Schema.parse(
      await readJson(expected.outputPath),
    );
    assertEqual(artifact.liveMemory.runId, expected.runId, "private coverage artifact run ID");
    return artifact;
  }
  if (expected.kind === "remediation-bundle") {
    const completion = completionSchemas["remediation-bundle"].parse(output);
    assertEqual(completion.outputPath, expected.outputPath, "remediation bundle output path");
    assertEqual(completion.runId, expected.runId, "remediation bundle run ID");
    const artifact = thinRemediationProofV1Schema.parse(await readJson(expected.outputPath));
    assertEqual(artifact.runId, expected.runId, "remediation bundle artifact run ID");
    return artifact;
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
    const artifact = recordingReadyReceiptSchema.parse(await readJson(expected.outputPath));
    assertEqual(artifact.recordingId, completion.recordingId, "recording-ready recording ID");
    assertEqual(artifact.runId, expected.runId, "recording-ready artifact run ID");
    return artifact;
  }
  if (expected.kind === "replay-attestation-publisher") {
    const completion = completionSchemas["replay-attestation-publisher"].parse(output);
    assertEqual(completion.remoteAttestationPath, expected.remoteAttestationPath, "replay attestation path");
    assertEqual(completion.runId, expected.runId, "replay attestation run ID");
    if (expected.recordingId !== undefined) {
      assertEqual(completion.recordingId, expected.recordingId, "replay attestation recording ID");
    }
    const manifest = fixtureManifestV1Schema.parse(await readJson(expected.fixtureManifestPath));
    assertEqual(completion.fixtureSetId, manifest.fixtureSetId, "replay attestation fixture set ID");
    return completion;
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
  const pathStatus = await lstat(path);
  assertSecureArtifact(pathStatus);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    assertSecureArtifact(before);
    if (before.dev !== pathStatus.dev || before.ino !== pathStatus.ino) {
      throw new Error("Hosted finite process artifact changed before read");
    }
    const bytes = new Uint8Array(before.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("Hosted finite process artifact changed while reading");
    }
    const encoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    return JSON.parse(encoded) as unknown;
  } finally {
    await handle?.close();
  }
}

function assertSecureArtifact(status: {
  readonly mode: number;
  readonly size: number;
  readonly uid: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): void {
  const owned = typeof process.getuid !== "function" || status.uid === process.getuid();
  if (status.isSymbolicLink() || !status.isFile() || !owned || (status.mode & 0o777) !== 0o600 ||
    status.size < 1 || status.size > maximumCompletionArtifactBytes) {
    throw new Error("Hosted finite process artifact must be a regular owned mode-0600 file of at most 32 MiB");
  }
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
