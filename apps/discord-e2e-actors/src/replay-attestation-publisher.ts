import { readFile } from "node:fs/promises";

import { z } from "zod";

import { fixtureManifestV1Schema } from "./e2e-evidence-schema.js";
import { runRemoteProbe } from "./ssh-deployment-probe-commands.js";
import { parseSshDeploymentProbeOptions } from "./ssh-deployment-probe-validation.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const attestationPath = z.string().regex(
  /^\/tmp\/discord-e2e-attestations\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u,
);

export interface ReplayAttestationPublisherConfig {
  readonly composeFile: string;
  readonly envFile: string;
  readonly fixtureManifestPath: string;
  readonly host: "codex-workers-eu-01";
  readonly mutationTarget: "test-only";
  readonly recordingId: string;
  readonly remoteAttestationPath: string;
  readonly remoteSourceRoot: string;
  readonly runId: string;
}

export interface ReplayAttestationPublisherResult {
  readonly containerId: string;
  readonly fixtureSetId: string;
  readonly imageId: string;
  readonly recordingId: string;
  readonly remoteAttestationPath: string;
  readonly runId: string;
  readonly sourceRevision: string;
}

export type ReplayAttestationRemoteRunner = (
  config: ReplayAttestationPublisherConfig,
  script: string,
  args: readonly string[],
) => Promise<string>;

const remoteCreateScript = String.raw`
set -eu
container_ids="$(docker compose --env-file "$1" -f "$2" -p discord-meeting-assistant ps -q meeting-platform)"
set -- $container_ids
[ "$#" -eq 1 ] || { echo "expected exactly one meeting-platform container" >&2; exit 41; }
container_id="$1"
labels="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}} {{index .Config.Labels "e2e.test-only"}}' "$container_id")"
[ "$labels" = 'discord-meeting-assistant meeting-platform true' ] || {
  echo "refusing non-test replay target" >&2
  exit 42
}
image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
source_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
current_container_ids="$(docker compose --env-file "$1" -f "$2" -p discord-meeting-assistant ps -q meeting-platform)"
[ "$current_container_ids" = "$container_id" ] || {
  echo "meeting-platform container changed during attestation" >&2
  exit 43
}
node --input-type=module -e "$3" "$4" "$5" "$container_id" "$image_id" "$source_revision"
`;

const createOnlyNodeProgram = String.raw`
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const [path, encoded, containerId, imageId, sourceRevision] = process.argv.slice(1);
const root = "/tmp/discord-e2e-attestations";
if (dirname(path) !== root || !/^\/tmp\/discord-e2e-attestations\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(path)) {
  throw new Error("replay attestation path is outside the private test root");
}
await mkdir(root, { recursive: true, mode: 0o700 });
const rootStats = await lstat(root);
if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || rootStats.uid !== process.getuid()) {
  throw new Error("replay attestation root is unsafe");
}
await chmod(root, 0o700);
if (!/^[a-f\d]{64}$/u.test(containerId) || !/^sha256:[a-f\d]{64}$/u.test(imageId) || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/u.test(sourceRevision)) {
  throw new Error("running replay target has invalid immutable provenance");
}
const base = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
const marker = { ...base, containerId, imageId, schemaVersion: 2, sourceRevision };
const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
try {
  await handle.writeFile(Buffer.from(JSON.stringify(marker) + "\n", "utf8"));
  await handle.sync();
} finally {
  await handle.close();
}
const stats = await lstat(path);
if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== process.getuid() || (stats.mode & 0o777) !== 0o600) {
  throw new Error("created replay attestation is unsafe");
}
console.log(JSON.stringify({ containerId, imageId, path, sourceRevision, status: "created" }));
`;

export async function publishReplayAttestation(
  config: ReplayAttestationPublisherConfig,
  runner: ReplayAttestationRemoteRunner = sshRemoteRunner,
): Promise<ReplayAttestationPublisherResult> {
  const validated = validateConfig(config);
  const manifest = fixtureManifestV1Schema.parse(JSON.parse(
    await readFile(validated.fixtureManifestPath, "utf8"),
  ) as unknown);
  const markerBase = {
    fixtureSetId: manifest.fixtureSetId,
    purpose: "bullmq-post-call-replay" as const,
    recordingId: validated.recordingId,
    runId: validated.runId,
  };
  const encoded = Buffer.from(`${JSON.stringify(markerBase)}\n`, "utf8").toString("base64url");
  const stdout = await runner(validated, remoteCreateScript, [
    validated.envFile,
    validated.composeFile,
    createOnlyNodeProgram,
    validated.remoteAttestationPath,
    encoded,
  ]);
  const line = stdout.trimEnd().split("\n").at(-1);
  const receipt = z.object({
    containerId: z.string().regex(/^[a-f\d]{64}$/u),
    imageId: z.string().regex(/^sha256:[a-f\d]{64}$/u),
    path: z.literal(validated.remoteAttestationPath),
    sourceRevision: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u),
    status: z.literal("created"),
  }).strict().parse(JSON.parse(line ?? "null") as unknown);
  return {
    containerId: receipt.containerId,
    fixtureSetId: markerBase.fixtureSetId,
    imageId: receipt.imageId,
    recordingId: markerBase.recordingId,
    remoteAttestationPath: validated.remoteAttestationPath,
    runId: markerBase.runId,
    sourceRevision: receipt.sourceRevision,
  };
}

function validateConfig(config: ReplayAttestationPublisherConfig): ReplayAttestationPublisherConfig {
  return z.object({
    composeFile: z.string().startsWith("/"),
    envFile: z.string().startsWith("/"),
    fixtureManifestPath: z.string().startsWith("/"),
    host: z.literal("codex-workers-eu-01"),
    mutationTarget: z.literal("test-only"),
    recordingId: identifier,
    remoteAttestationPath: attestationPath,
    remoteSourceRoot: z.string().startsWith("/"),
    runId: identifier,
  }).strict().parse(config);
}

async function sshRemoteRunner(
  config: ReplayAttestationPublisherConfig,
  script: string,
  args: readonly string[],
): Promise<string> {
  const settings = parseSshDeploymentProbeOptions({
    attestationFile: config.remoteAttestationPath,
    composeFile: config.composeFile,
    craigProjectName: "craig-meeting-e2e",
    craigServiceName: "bot",
    envFile: config.envFile,
    host: config.host,
    mutationTarget: config.mutationTarget,
    projectName: "discord-meeting-assistant",
    sourceRoot: config.remoteSourceRoot,
  });
  return runRemoteProbe(settings, ["sh", "-ceu", script, "replay-attestation-publisher", ...args]);
}
