import { z } from "zod";

import { publishReplayAttestation } from "./replay-attestation-publisher.js";

const absolutePath = z.string().startsWith("/");
const environmentSchema = z.object({
  DISCORD_E2E_REPLAY_FIXTURE_MANIFEST: absolutePath,
  DISCORD_E2E_REPLAY_MUTATION_TARGET: z.literal("test-only"),
  DISCORD_E2E_REPLAY_RECORDING_ID: z.string().min(1),
  DISCORD_E2E_REPLAY_REMOTE_ATTESTATION_FILE: absolutePath,
  DISCORD_E2E_REPLAY_REMOTE_COMPOSE_FILE: absolutePath,
  DISCORD_E2E_REPLAY_REMOTE_ENV_FILE: absolutePath,
  DISCORD_E2E_REPLAY_REMOTE_HOST: z.literal("codex-workers-eu-01"),
  DISCORD_E2E_REPLAY_REMOTE_SOURCE_ROOT: absolutePath,
  DISCORD_E2E_REPLAY_RUN_ID: z.string().min(1),
}).parse(process.env);

void publishReplayAttestation({
  composeFile: environmentSchema.DISCORD_E2E_REPLAY_REMOTE_COMPOSE_FILE,
  envFile: environmentSchema.DISCORD_E2E_REPLAY_REMOTE_ENV_FILE,
  fixtureManifestPath: environmentSchema.DISCORD_E2E_REPLAY_FIXTURE_MANIFEST,
  host: environmentSchema.DISCORD_E2E_REPLAY_REMOTE_HOST,
  mutationTarget: environmentSchema.DISCORD_E2E_REPLAY_MUTATION_TARGET,
  recordingId: environmentSchema.DISCORD_E2E_REPLAY_RECORDING_ID,
  remoteAttestationPath: environmentSchema.DISCORD_E2E_REPLAY_REMOTE_ATTESTATION_FILE,
  remoteSourceRoot: environmentSchema.DISCORD_E2E_REPLAY_REMOTE_SOURCE_ROOT,
  runId: environmentSchema.DISCORD_E2E_REPLAY_RUN_ID,
}).then((result): void => {
  process.stdout.write(`${JSON.stringify({
    ...result, kind: "replay-attestation-publisher-completion", status: "ready",
  })}\n`);
  return undefined;
}).catch((error: unknown) => {
  process.stderr.write(`Replay attestation publication failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
