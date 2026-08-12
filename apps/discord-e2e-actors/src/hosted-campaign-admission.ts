import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, open, realpath, rm, statfs, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { z } from "zod";

import { fixtureManifestV1Schema } from "./e2e-evidence-schema.js";
import { serviceLevelThresholdsSchema } from "./e2e-service-levels.js";
import {
  buildResolvedHostedCampaignPlanV1,
  hostedCampaignDefinitionV1Schema,
  hostedCampaignRuntimeBindingsV1Schema,
} from "./hosted-campaign-plan-builder.js";
import { parseHostedCampaignPlan } from "./hosted-campaign-run-config.js";
import { FileSecretReader } from "./keychain.js";
import { loadVerifiedSupplementalVoiceManifest } from "./supplemental-voice-playback-config.js";

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const remoteCapabilitySchema = z.enum([
  "clock-preflight",
  "conversation-greeting-readiness",
  "craig-test-identity",
  "remote-test-isolation",
  "revision-qualified-containers",
  "voicetext-semantic-canary",
]);
const baseRemoteEvidenceSchema = z.object({
    capability: remoteCapabilitySchema,
    path: z.string().refine((value) => isSafeAbsolutePath(value)),
    sha256: sha256Schema,
  });
const remoteEvidenceSchema = z.object({
  capabilities: z.array(z.union([
    baseRemoteEvidenceSchema.extend({
      capability: z.literal("conversation-greeting-readiness"),
      greetingHandshakeRoot: z.string().refine((value) => isSafeAbsolutePath(value)),
      observerParticipantId: z.literal("1533867700575670282"),
    }).strict(),
    baseRemoteEvidenceSchema.refine(
      ({ capability }) => capability !== "conversation-greeting-readiness",
    ),
  ])).max(6),
  schemaVersion: z.literal(1),
}).strict();

const requiredRemoteCapabilities = remoteCapabilitySchema.options;
const secretAccounts = ["sut", "speaker-a", "speaker-b", "conversation-observer", "speaker-d"] as const;
const maximumInputBytes = 16 * 1024 * 1024;

export type HostedCampaignAdmissionReceiptV1 = Readonly<{
  artifactRoot: string;
  bindingsSha256: string;
  campaignId: string;
  definitionSha256: string;
  fixtureDigests: Readonly<Record<string, string>>;
  generatedAt: string;
  kind: "hosted-campaign-admission";
  minimumFreeBytes: number;
  missingCapabilities: readonly z.infer<typeof remoteCapabilitySchema>[];
  planSha256: string;
  receiptSha256: string;
  remoteEvidence: readonly Readonly<{
    capability: z.infer<typeof remoteCapabilitySchema>;
    greetingHandshakeRoot?: string;
    observerParticipantId?: string;
    path: string;
    sha256: string;
  }>[];
  revisions: Readonly<Record<"craig" | "meetingPlatform" | "pipecat" | "subscriptionRuntime", string>>;
  schemaVersion: 1;
  secretAccountsValidated: typeof secretAccounts;
  status: "admitted" | "blocked";
}>;

export interface HostedCampaignAdmissionRequest {
  readonly bindings: unknown;
  readonly definition: unknown;
  readonly minimumFreeBytes: number;
  readonly plan: unknown;
  readonly remoteEvidence?: unknown;
}

export async function inspectHostedCampaignAdmission(
  request: HostedCampaignAdmissionRequest,
  now: () => number = Date.now,
): Promise<HostedCampaignAdmissionReceiptV1> {
  const definition = hostedCampaignDefinitionV1Schema.parse(request.definition);
  const bindings = hostedCampaignRuntimeBindingsV1Schema.parse(request.bindings);
  const plan = parseHostedCampaignPlan(request.plan);
  const compiledPlan = buildResolvedHostedCampaignPlanV1(definition, bindings);
  if (digestCanonical(plan) !== digestCanonical(compiledPlan)) {
    throw new Error("Hosted admission plan does not match the definition and bindings");
  }
  if (!Number.isSafeInteger(request.minimumFreeBytes) || request.minimumFreeBytes < 1) {
    throw new Error("Hosted admission minimum free bytes must be a positive safe integer");
  }
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
  const expectedSpeakerPaths = manifest.fixtures.slice(0, 2).map(({ audioPath }) =>
    resolve(dirname(definition.fixtureManifestPath), audioPath));
  if (resolve(definition.speakerFixtures.a) !== expectedSpeakerPaths[0]
    || resolve(definition.speakerFixtures.b) !== expectedSpeakerPaths[1]) {
    throw new Error("Hosted speaker fixture paths do not match the pinned fixture manifest");
  }

  const secrets = new FileSecretReader(definition.secretDirectory);
  await Promise.all(secretAccounts.map(async (account) => {
    await secrets.read(account);
  }));

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
  const greetingEvidence = remoteEvidence.find((evidence) =>
    "greetingHandshakeRoot" in evidence);
  const observer = plan.children.find(({ childId }) => childId === "conversation-observer");
  const plannedGreetingRoot = observer?.environment
    .DISCORD_E2E_CONVERSATION_VOICE_GREETING_HANDSHAKE_ROOT;
  if (greetingEvidence !== undefined && "greetingHandshakeRoot" in greetingEvidence &&
    (greetingEvidence.greetingHandshakeRoot !== plannedGreetingRoot ||
      greetingEvidence.observerParticipantId !== observer?.environment
        .DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID)) {
    throw new Error("Greeting readiness evidence does not match the exact observer plan binding");
  }
  // These files are retained declarations only. They are not trusted probe receipts.
  // Keep admission blocked until each capability has a typed, independently verified schema.
  const missingCapabilities = requiredRemoteCapabilities;
  const content = {
    artifactRoot,
    bindingsSha256: digestCanonical(bindings),
    campaignId: definition.campaignId,
    definitionSha256: digestCanonical(definition),
    fixtureDigests: Object.freeze(fixtureDigests),
    generatedAt: new Date(now()).toISOString(),
    kind: "hosted-campaign-admission" as const,
    minimumFreeBytes: request.minimumFreeBytes,
    missingCapabilities: Object.freeze(missingCapabilities),
    planSha256: digestCanonical(plan),
    remoteEvidence: Object.freeze(remoteEvidence),
    revisions: Object.freeze({ ...definition.revisions }),
    schemaVersion: 1 as const,
    secretAccountsValidated: secretAccounts,
    status: missingCapabilities.length === 0 ? "admitted" as const : "blocked" as const,
  };
  return Object.freeze({ ...content, receiptSha256: digestCanonical(content) });
}

export function verifyHostedCampaignAdmissionReceipt(value: unknown): HostedCampaignAdmissionReceiptV1 {
  const receiptSchema = z.object({
    artifactRoot: z.string().refine(isSafeAbsolutePath), campaignId: z.string().min(1),
    bindingsSha256: sha256Schema, definitionSha256: sha256Schema,
    fixtureDigests: z.record(z.string(), sha256Schema), generatedAt: z.iso.datetime(),
    kind: z.literal("hosted-campaign-admission"), minimumFreeBytes: z.number().int().safe().positive(),
    missingCapabilities: z.array(remoteCapabilitySchema), planSha256: sha256Schema, receiptSha256: sha256Schema,
    remoteEvidence: remoteEvidenceSchema.shape.capabilities,
    revisions: z.object({ craig: z.string(), meetingPlatform: z.string(), pipecat: z.string(), subscriptionRuntime: z.string() }).strict(),
    schemaVersion: z.literal(1), secretAccountsValidated: z.array(z.enum(secretAccounts)).length(secretAccounts.length),
    status: z.enum(["admitted", "blocked"]),
  }).strict();
  const receipt = receiptSchema.parse(value);
  const { receiptSha256, ...content } = receipt;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Hosted campaign admission receipt digest is invalid");
  }
  const expectedStatus = receipt.missingCapabilities.length === 0 ? "admitted" : "blocked";
  if (receipt.status !== expectedStatus) {
    throw new Error("Hosted campaign admission status is inconsistent");
  }
  if (receipt.secretAccountsValidated.some((account, index) => account !== secretAccounts[index])) {
    throw new Error("Hosted campaign admission secret account set is invalid");
  }
  return Object.freeze({
    ...receipt,
    secretAccountsValidated: secretAccounts,
  });
}

export interface HostedCampaignAdmissionInvocation {
  readonly bindings: unknown;
  readonly definition: unknown;
  readonly maximumAgeMs: number;
  readonly nowEpochMs: number;
  readonly plan: unknown;
  readonly receipt: unknown;
}

export function assertAdmissionMatchesInvocation(
  invocation: HostedCampaignAdmissionInvocation,
): HostedCampaignAdmissionReceiptV1 {
  const receipt = verifyHostedCampaignAdmissionReceipt(invocation.receipt);
  const definition = hostedCampaignDefinitionV1Schema.parse(invocation.definition);
  const bindings = hostedCampaignRuntimeBindingsV1Schema.parse(invocation.bindings);
  const plan = parseHostedCampaignPlan(invocation.plan);
  const generatedAt = Date.parse(receipt.generatedAt);
  if (receipt.status !== "admitted" || receipt.missingCapabilities.length !== 0) {
    throw new Error("Hosted campaign admission is not admitted");
  }
  if (!Number.isSafeInteger(invocation.nowEpochMs) || !Number.isSafeInteger(invocation.maximumAgeMs)
    || invocation.maximumAgeMs < 1 || generatedAt > invocation.nowEpochMs
    || invocation.nowEpochMs - generatedAt > invocation.maximumAgeMs) {
    throw new Error("Hosted campaign admission is stale or from the future");
  }
  const campaignId = plan.runs[0]?.campaignId;
  const artifactRoot = resolve(definition.campaignRoot, definition.campaignId);
  if (receipt.campaignId !== campaignId || receipt.campaignId !== definition.campaignId
    || receipt.artifactRoot !== artifactRoot || receipt.definitionSha256 !== digestCanonical(definition)
    || receipt.bindingsSha256 !== digestCanonical(bindings) || receipt.planSha256 !== digestCanonical(plan)
    || JSON.stringify(receipt.revisions) !== JSON.stringify(definition.revisions)) {
    throw new Error("Hosted campaign admission does not match this invocation");
  }
  return receipt;
}

export async function writeCreateOnlyAdmissionReceipt(
  path: string,
  receipt: HostedCampaignAdmissionReceiptV1,
): Promise<void> {
  if (!isSafeAbsolutePath(path)) {throw new Error("Hosted admission receipt path is unsafe");}
  const temporaryPath = join(dirname(path), `.${basename(path)}.partial-${randomUUID()}`);
  const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, undefined, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await link(temporaryPath, path);
  } finally {
    await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true });
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

async function digestPrivateFile(path: string): Promise<string> {
  return sha256(await readPrivateFile(path));
}

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
  } finally {
    await handle?.close();
  }
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
  while (true) {
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
      if (parent === candidate) {
        throw new Error("Hosted admission artifact parent does not exist", { cause: error });
      }
      candidate = parent;
    }
  }
}

function isSafeAbsolutePath(value: string): boolean {
  return isAbsolute(value) && normalize(value) !== "/";
}

function digestCanonical(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(canonicalize(value)), "utf8"));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonicalize);}
  if (typeof value !== "object" || value === null) {return value;}
  return Object.fromEntries(Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalize(nested)]));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}
