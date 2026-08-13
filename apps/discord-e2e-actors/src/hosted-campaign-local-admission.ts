import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, realpath, statfs, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

import { z } from "zod";

import { fixtureManifestV1Schema } from "./e2e-evidence-schema.js";
import { serviceLevelThresholdsSchema } from "./e2e-service-levels.js";
import type { HostedCampaignDefinitionV1 } from "./hosted-campaign-plan-builder.js";
import { parseHostedCampaignPlan } from "./hosted-campaign-run-config.js";
import { FileSecretReader } from "./keychain.js";
import { loadVerifiedSupplementalVoiceManifest } from "./supplemental-voice-playback-config.js";

export const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
export const remoteCapabilitySchema = z.enum([
  "clock-preflight", "conversation-greeting-readiness", "craig-test-identity",
  "remote-test-isolation", "revision-qualified-containers", "voicetext-semantic-canary",
]);
const baseRemoteEvidenceSchema = z.object({
    capability: remoteCapabilitySchema,
    path: z.string().refine((value) => isSafeAbsolutePath(value)),
    sha256: sha256Schema,
  });
export const remoteEvidenceSchema = z.object({
  capabilities: z.array(z.union([
    baseRemoteEvidenceSchema.extend({
      capability: z.literal("conversation-greeting-readiness"),
      containerGreetingHandshakeRoot: z.string().refine((value) => isSafeAbsolutePath(value)),
      greetingHandshakeRoot: z.string().refine((value) => isSafeAbsolutePath(value)),
      hostOwnerUid: z.number().int().nonnegative(),
      observerParticipantId: z.literal("1533867700575670282"),
      platformContainerUid: z.literal(10_001),
    }).strict(),
    baseRemoteEvidenceSchema.refine(
      ({ capability }) => capability !== "conversation-greeting-readiness",
    ),
  ])).max(6),
  schemaVersion: z.literal(1),
}).strict();

export const secretAccounts = ["sut", "speaker-a", "speaker-b", "conversation-observer", "speaker-d"] as const;
const maximumInputBytes = 16 * 1024 * 1024;

export interface HostedCampaignLocalAdmissionRequest {
  readonly definition: HostedCampaignDefinitionV1;
  readonly minimumFreeBytes: number;
  readonly plan: ReturnType<typeof parseHostedCampaignPlan>;
  readonly remoteEvidence?: unknown;
}

export async function inspectHostedCampaignLocalAdmission(
  request: HostedCampaignLocalAdmissionRequest,
) {
  const { definition, plan } = request;
  const artifactRoot = resolve(definition.campaignRoot, definition.campaignId);
  if (!isSafeAbsolutePath(artifactRoot)) {
    throw new Error("Hosted admission artifact root is unsafe");
  }
  await assertFreeDiskSpace(definition.campaignRoot, request.minimumFreeBytes);
  const manifest = fixtureManifestV1Schema.parse(await readPrivateJson(definition.fixtureManifestPath));
  const fixtureDigests: Record<string, string> = {
    fixtureManifest: await digestPrivateFile(definition.fixtureManifestPath),
    serviceLevelThresholds: await digestAndParse(definition.serviceLevelThresholdsPath, serviceLevelThresholdsSchema),
    supplementalManifest: await digestPrivateFile(definition.supplementalManifestPath),
  };
  await loadVerifiedSupplementalVoiceManifest(definition.supplementalManifestPath, 120_000);
  for (const fixture of manifest.fixtures) {
    const sourcePath = resolve(dirname(definition.fixtureManifestPath), fixture.sourcePath);
    const audioPath = resolve(dirname(definition.fixtureManifestPath), fixture.audioPath);
    fixtureDigests[`fixture:${fixture.fixtureId}:source`] = await assertDigest(sourcePath, fixture.sourceSha256);
    fixtureDigests[`fixture:${fixture.fixtureId}:audio`] = await assertDigest(audioPath, fixture.audioSha256);
  }
  assertSpeakerFixturePaths(definition.speakerFixtures, manifest.fixtures.slice(0, 2).map(({ audioPath }) =>
    resolve(dirname(definition.fixtureManifestPath), audioPath)));
  const secrets = new FileSecretReader(definition.secretDirectory);
  await Promise.all(secretAccounts.map(async (account) => secrets.read(account)));

  const supplied = request.remoteEvidence === undefined
    ? { capabilities: [], schemaVersion: 1 as const }
    : remoteEvidenceSchema.parse(request.remoteEvidence);
  const capabilityNames = supplied.capabilities.map(({ capability }) => capability);
  if (new Set(capabilityNames).size !== capabilityNames.length) {
    throw new Error("Hosted admission remote capability evidence must be unique");
  }
  const remoteEvidence = await Promise.all(supplied.capabilities.map(async (evidence) => ({
    ...evidence,
    sha256: await assertDigest(evidence.path, evidence.sha256),
  })));
  const greetingEvidence = remoteEvidence.find((evidence) => "greetingHandshakeRoot" in evidence);
  const observer = plan.children.find(({ childId }) => childId === "conversation-observer");
  const plannedGreetingRoot = observer?.environment.DISCORD_E2E_CONVERSATION_VOICE_GREETING_HANDSHAKE_ROOT;
  const expectedContainerGreetingRoot = plannedGreetingRoot === undefined ? undefined : join(
    "/var/lib/discord-meeting/e2e-playback-readiness",
    relative(definition.campaignRoot, plannedGreetingRoot),
  );
  if (greetingEvidence !== undefined && "greetingHandshakeRoot" in greetingEvidence &&
    (greetingEvidence.greetingHandshakeRoot !== plannedGreetingRoot ||
      greetingEvidence.containerGreetingHandshakeRoot !== expectedContainerGreetingRoot ||
      greetingEvidence.observerParticipantId !== observer?.environment
        .DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID)) {
    throw new Error("Greeting readiness evidence does not match the exact observer plan binding");
  }
  return Object.freeze({ artifactRoot, fixtureDigests: Object.freeze(fixtureDigests), remoteEvidence: Object.freeze(remoteEvidence) });
}

function assertSpeakerFixturePaths(
  fixtures: Readonly<{ a: string; b: string }>, expectedPaths: readonly (string | undefined)[],
): void {
  if (resolve(fixtures.a) !== expectedPaths[0] || resolve(fixtures.b) !== expectedPaths[1]) {
    throw new Error("Hosted speaker fixture paths do not match the pinned fixture manifest");
  }
}

async function digestAndParse(path: string, schema: z.ZodType): Promise<string> {
  const bytes = await readPrivateFile(path);
  schema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  return sha256(bytes);
}

async function readPrivateJson(path: string): Promise<unknown> {
  return JSON.parse((await readPrivateFile(path)).toString("utf8")) as unknown;
}

async function digestPrivateFile(path: string): Promise<string> { return sha256(await readPrivateFile(path)); }

async function assertDigest(path: string, expected: string): Promise<string> {
  const actual = await digestPrivateFile(path);
  if (actual !== expected) {throw new Error(`Hosted admission digest mismatch for ${basename(path)}`);}
  return actual;
}

async function readPrivateFile(path: string): Promise<Buffer> {
  if (!isSafeAbsolutePath(path)) {throw new Error("Hosted admission input path is unsafe");}
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    assertPrivateFile(before);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) {
      throw new Error("Hosted admission input changed while reading");
    }
    return bytes;
  } finally { await handle?.close(); }
}

function assertPrivateFile(status: Stats): void {
  if (!status.isFile() || status.size < 2 || status.size > maximumInputBytes || (status.mode & 0o077) !== 0) {
    throw new Error("Hosted admission inputs must be private regular files of at most 16 MiB");
  }
  if (typeof process.getuid !== "function" || status.uid !== process.getuid()) {
    throw new Error("Hosted admission input ownership cannot be established");
  }
}

async function assertFreeDiskSpace(path: string, requiredBytes: number): Promise<void> {
  let candidate = resolve(path);
  for (;;) {
    try {
      const resolved = await realpath(candidate);
      const space = await statfs(resolved);
      const available = space.bavail * space.bsize;
      if (!Number.isSafeInteger(available) || available < requiredBytes) {
        throw new Error("Hosted admission has insufficient free disk space");
      }
      return;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {throw error;}
      const parent = dirname(candidate);
      if (parent === candidate) {throw new Error("Hosted admission artifact parent does not exist", { cause: error });}
      candidate = parent;
    }
  }
}

export function isSafeAbsolutePath(value: string): boolean {
  return isAbsolute(value) && normalize(value) !== "/";
}

export function digestCanonical(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(canonicalize(value)), "utf8"));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonicalize);}
  if (typeof value !== "object" || value === null) {return value;}
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalize(nested)]));
}

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}
