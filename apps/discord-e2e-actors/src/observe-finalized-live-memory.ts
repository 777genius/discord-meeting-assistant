import { isAbsolute } from "node:path";

import { z } from "zod";

import { readStablePrivateJson } from "./compile-hosted-campaign-plan.js";
import { writeCreateOnlyPrivateJson } from "./create-only-private-json.js";
import { conversationVoiceCampaignProofV1Schema } from "./conversation-voice-campaign-proof.js";
import { finalizedLiveMemoryQualificationV1Schema } from "./finalized-live-memory-qualification.js";
import { SshDeploymentEvidenceProbe } from "./ssh-deployment-probe.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-target.js";
import { rejectTokenEnvironment, sanitizedCliError } from "./cli-secret-safety.js";

const environmentSchema = z.object({
  DISCORD_E2E_LIVE_MEMORY_CAMPAIGN_ID: z.string().trim().min(1),
  DISCORD_E2E_LIVE_MEMORY_CAMPAIGN_PROOF_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_LIVE_MEMORY_MUTATION_TARGET: z.literal("private-test-guild"),
  DISCORD_E2E_LIVE_MEMORY_OUTPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_LIVE_MEMORY_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(5_000).default(250),
  DISCORD_E2E_LIVE_MEMORY_REMOTE_COMPOSE_FILE: z.string().refine(isAbsolute),
  DISCORD_E2E_LIVE_MEMORY_REMOTE_ENV_FILE: z.string().refine(isAbsolute),
  DISCORD_E2E_LIVE_MEMORY_REMOTE_HOST: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u),
  DISCORD_E2E_LIVE_MEMORY_REMOTE_SOURCE_ROOT: z.string().refine(isAbsolute),
  DISCORD_E2E_LIVE_MEMORY_RUN_ID: z.string().trim().min(1),
  DISCORD_E2E_LIVE_MEMORY_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(2_700_000),
}).loose();

interface TranscriptLogEvent {
  readonly endMs: number;
  readonly meetingId: string;
  readonly observedAt: string;
  readonly speakerId: string;
  readonly startMs: number;
}

interface LogWait {
  readonly coordinate?: TranscriptLogEvent;
  readonly deadline: number;
  readonly message: string;
  readonly meetingId: string;
  readonly pollMs: number;
  readonly since: string;
}

async function main(): Promise<void> {
  rejectTokenEnvironment(process.env);
  const config = environmentSchema.parse(process.env);
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + config.DISCORD_E2E_LIVE_MEMORY_TIMEOUT_MS;
  const campaignProof = conversationVoiceCampaignProofV1Schema.parse(await waitForJson(
    config.DISCORD_E2E_LIVE_MEMORY_CAMPAIGN_PROOF_INPUT, deadline,
  ));
  if (campaignProof.observerReadyReceipt.runId !== config.DISCORD_E2E_LIVE_MEMORY_RUN_ID) {
    throw new Error("Live-memory observer is bound to another campaign run");
  }
  const expectedMeetingId = campaignProof.observerReadyReceipt.meetingId;
  const probe = new SshDeploymentEvidenceProbe({
    composeFile: config.DISCORD_E2E_LIVE_MEMORY_REMOTE_COMPOSE_FILE,
    craigProjectName: "craig-meeting-e2e", craigServiceName: "bot",
    envFile: config.DISCORD_E2E_LIVE_MEMORY_REMOTE_ENV_FILE,
    host: config.DISCORD_E2E_LIVE_MEMORY_REMOTE_HOST,
    mutationTarget: "test-only", projectName: "discord-meeting-assistant",
    sourceRoot: config.DISCORD_E2E_LIVE_MEMORY_REMOTE_SOURCE_ROOT,
    timeoutMs: Math.min(300_000, config.DISCORD_E2E_LIVE_MEMORY_TIMEOUT_MS),
  });
  const partial = await waitForLog(probe, {
    deadline, message: "Live transcript partial excluded from finalized memory",
    meetingId: expectedMeetingId,
    pollMs: config.DISCORD_E2E_LIVE_MEMORY_POLL_INTERVAL_MS, since: startedAt,
  });
  const partialRows = await probe.collectLiveMemoryRows(partial.meetingId);
  const final = await waitForLog(probe, {
    coordinate: partial, deadline, message: "Live transcript turn finalized",
    meetingId: expectedMeetingId,
    pollMs: config.DISCORD_E2E_LIVE_MEMORY_POLL_INTERVAL_MS, since: startedAt,
  });
  const finalRows = await waitForFinalProjection(probe, partialRows, final, deadline,
    config.DISCORD_E2E_LIVE_MEMORY_POLL_INTERVAL_MS);
  const finalizedTurnId = finalRows.canonicalTurns.find(({ turnId }) =>
    !partialRows.canonicalTurns.some((partialTurn) => partialTurn.turnId === turnId))!.turnId;
  const processBeforeRestart = await probe.collectMeetingPlatformWorkerProcess();
  const processAfterRestart = await waitForReplacementProcess(probe, processBeforeRestart.hostProcessId,
    deadline, config.DISCORD_E2E_LIVE_MEMORY_POLL_INTERVAL_MS);
  const backfillRows = await waitForBackfill(probe, final.meetingId, finalizedTurnId, deadline,
    config.DISCORD_E2E_LIVE_MEMORY_POLL_INTERVAL_MS);
  const proof = finalizedLiveMemoryQualificationV1Schema.parse({
    backfill: { process: processAfterRestart, rows: backfillRows },
    botActorId: HOSTED_CAMPAIGN_TARGET.botikApplicationId,
    campaignId: config.DISCORD_E2E_LIVE_MEMORY_CAMPAIGN_ID,
    final: { event: final, rows: finalRows }, finalizedTurnId,
    kind: "finalized-live-memory-qualification",
    partial: { event: partial, rows: partialRows }, processBeforeRestart,
    trustedHumanSpeakerId: final.speakerId,
    runId: config.DISCORD_E2E_LIVE_MEMORY_RUN_ID, schemaVersion: 1,
  });
  await writeCreateOnlyPrivateJson(config.DISCORD_E2E_LIVE_MEMORY_OUTPUT, proof);
  process.stdout.write(`${JSON.stringify({
    kind: "live-memory-observer-completion", outputPath: config.DISCORD_E2E_LIVE_MEMORY_OUTPUT,
    runId: config.DISCORD_E2E_LIVE_MEMORY_RUN_ID, status: "completed",
  })}\n`);
}

async function waitForLog(
  probe: SshDeploymentEvidenceProbe, input: LogWait,
): Promise<TranscriptLogEvent> {
  for (;;) {
    const matches = parseTranscriptLogs(
      await probe.collectMeetingPlatformLogsSince(input.since), input.message,
    ).filter((event) => event.meetingId === input.meetingId &&
      (input.coordinate === undefined || sameCoordinate(event, input.coordinate)));
    if (matches.length === 1) { return matches[0]!; }
    if (matches.length > 1) { throw new Error(`Live-memory observation found ambiguous ${input.message} events`); }
    await poll(input.deadline, input.pollMs);
  }
}

async function waitForJson(path: string, deadline: number): Promise<unknown> {
  for (;;) {
    try { return await readStablePrivateJson(path); }
    catch (error: unknown) {
      if (Date.now() >= deadline) { throw error; }
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  }
}

function parseTranscriptLogs(output: string, message: string): TranscriptLogEvent[] {
  const matches: TranscriptLogEvent[] = [];
  for (const line of output.split("\n")) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if ((value.msg ?? value.message) !== message) { continue; }
      matches.push(z.object({
        endMs: z.number().int().positive(), meetingId: z.string().trim().min(1),
        observedAt: z.iso.datetime(), speakerId: z.string().trim().min(1),
        startMs: z.number().int().nonnegative(),
      }).loose().parse(value));
    } catch {}
  }
  return matches;
}

function sameCoordinate(left: TranscriptLogEvent, right: TranscriptLogEvent): boolean {
  return left.meetingId === right.meetingId && left.speakerId === right.speakerId &&
    left.startMs === right.startMs && left.endMs === right.endMs;
}

async function waitForFinalProjection(
  probe: SshDeploymentEvidenceProbe,
  partial: Awaited<ReturnType<SshDeploymentEvidenceProbe["collectLiveMemoryRows"]>>,
  final: TranscriptLogEvent, deadline: number, pollMs: number,
) {
  for (;;) {
    const rows = await probe.collectLiveMemoryRows(final.meetingId);
    const added = rows.canonicalTurns.filter(({ turnId }) =>
      !partial.canonicalTurns.some((candidate) => candidate.turnId === turnId));
    if (added.length === 1 && rows.hotTail.some(({ turnId }) => turnId === added[0]!.turnId) &&
      rows.outbox.some(({ state, turnId }) => turnId === added[0]!.turnId && state === "applied")) {
      return rows;
    }
    if (Date.now() - Date.parse(final.observedAt) > 5_000) {
      throw new Error("Finalized live-memory projection exceeded five seconds");
    }
    await poll(deadline, pollMs);
  }
}

async function waitForReplacementProcess(
  probe: SshDeploymentEvidenceProbe, beforePid: number, deadline: number, pollMs: number,
) {
  for (;;) {
    const process = await probe.collectMeetingPlatformWorkerProcess();
    if (process.hostProcessId !== beforePid) { return process; }
    await poll(deadline, pollMs);
  }
}

async function waitForBackfill(
  probe: SshDeploymentEvidenceProbe, meetingId: string, turnId: string,
  deadline: number, pollMs: number,
) {
  for (;;) {
    const rows = await probe.collectLiveMemoryRows(meetingId);
    if (rows.canonicalTurns.some((turn) => turn.turnId === turnId) &&
      rows.hotTail.some((turn) => turn.turnId === turnId)) { return rows; }
    await poll(deadline, pollMs);
  }
}

async function poll(deadline: number, milliseconds: number): Promise<void> {
  if (Date.now() >= deadline) { throw new Error("Finalized live-memory observation timed out"); }
  await new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/observe-finalized-live-memory.js") === true) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Finalized live-memory observation failed: ${sanitizedCliError(error, process.env)}\n`);
    process.exitCode = 1;
  });
}
