/* Admission intentionally centralizes local validation and trusted remote receipt binding. */
/* oxlint-disable max-lines */
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, realpath, statfs, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

import { z } from "zod";

import { fixtureManifestV1Schema } from "./e2e-evidence-schema.js";
import { serviceLevelThresholdsSchema } from "./e2e-service-levels.js";
import {
  buildResolvedHostedCampaignPlanV1,
  hostedCampaignDefinitionV1Schema,
  hostedCampaignRuntimeBindingsV1Schema,
} from "./hosted-campaign-plan-builder.js";
import { parseHostedCampaignPlan } from "./hosted-campaign-run-config.js";
import {
  evaluateHostedRemoteAdmission,
  type HostedCampaignRemoteAdmissionProbe,
  type HostedCampaignRemoteAdmissionProbeRequest,
  type HostedRemoteReadinessSection,
  hostedRemoteReadinessV1Schema,
  type HostedRemoteReadinessV1,
  verifyHostedRemoteReadinessV1,
} from "./hosted-campaign-remote-admission.js";
import { FileSecretReader } from "./keychain.js";
import { hostedClockPreflightReceiptV2Schema, type HostedClockPreflightReceiptV2 } from "./hosted-clock-proof-v2.js";
import { loadVerifiedSupplementalVoiceManifest } from "./supplemental-voice-playback-config.js";

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const remoteCapabilitySchema = z.enum([
  "clock-preflight", "conversation-greeting-readiness", "craig-test-identity",
  "remote-test-isolation", "revision-qualified-containers", "voicetext-semantic-canary",
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
  clockPreflightProof?: HostedClockPreflightReceiptV2 | undefined;
  minimumFreeBytes: number;
  missingCapabilities: readonly HostedRemoteReadinessSection[];
  planSha256: string;
  receiptSha256: string;
  remoteEvidence: readonly Readonly<{
    capability: z.infer<typeof remoteCapabilitySchema>;
    containerGreetingHandshakeRoot?: string;
    greetingHandshakeRoot?: string;
    hostOwnerUid?: number;
    observerParticipantId?: string;
    platformContainerUid?: number;
    path: string;
    sha256: string;
  }>[];
  remoteReadiness?: HostedRemoteReadinessV1 | undefined;
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
  readonly remoteAdmissionProbe?: HostedCampaignRemoteAdmissionProbe;
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
  assertSpeakerFixturePaths(definition.speakerFixtures, expectedSpeakerPaths);

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
  const expectedContainerGreetingRoot = plannedGreetingRoot === undefined
    ? undefined
    : join(
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
  // Operator-authored files above are retained declarations only and can never authorize a run.
  // Only the injected consumer-owned probe is a trust boundary.
  const remoteAdmission = await evaluateRemote(request, definition.campaignId, plan, now);
  const generatedAtEpochMs = resolveAdmissionTime(remoteAdmission.readiness, now);
  const missingCapabilities = remoteAdmission.missingSections;
  const content = {
    artifactRoot,
    bindingsSha256: digestCanonical(bindings),
    campaignId: definition.campaignId,
    definitionSha256: digestCanonical(definition),
    fixtureDigests: Object.freeze(fixtureDigests),
    generatedAt: new Date(generatedAtEpochMs).toISOString(),
    kind: "hosted-campaign-admission" as const,
    ...(remoteAdmission.clockPreflightProof === undefined ? {} : {
      clockPreflightProof: remoteAdmission.clockPreflightProof,
    }),
    minimumFreeBytes: request.minimumFreeBytes,
    missingCapabilities: Object.freeze(missingCapabilities),
    planSha256: digestCanonical(plan),
    remoteEvidence: Object.freeze(remoteEvidence),
    ...(remoteAdmission.readiness === undefined ? {} : { remoteReadiness: remoteAdmission.readiness }),
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
    kind: z.literal("hosted-campaign-admission"), minimumFreeBytes: z.number().int().positive(),
    clockPreflightProof: hostedClockPreflightReceiptV2Schema.optional(),
    missingCapabilities: z.array(z.enum(["deploymentSafety", "discordIdentity", "voicetextCanary", "clockPreflight"])),
    planSha256: sha256Schema, receiptSha256: sha256Schema,
    remoteEvidence: remoteEvidenceSchema.shape.capabilities,
    remoteReadiness: hostedRemoteReadinessV1Schema.optional(),
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
  const uniqueMissing = new Set(receipt.missingCapabilities);
  if (uniqueMissing.size !== receipt.missingCapabilities.length) {
    throw new Error("Hosted campaign admission missing readiness sections are invalid");
  }
  if (receipt.status === "admitted" && receipt.remoteReadiness === undefined) {
    throw new Error("Hosted campaign admission has no trusted remote readiness");
  }
  if (receipt.status === "admitted" && receipt.clockPreflightProof === undefined) {
    throw new Error("Hosted campaign admission has no trusted clock preflight proof");
  }
  if (receipt.clockPreflightProof !== undefined && receipt.remoteReadiness?.clockPreflight.proofId
    !== receipt.clockPreflightProof.proofId) {
    throw new Error("Hosted campaign clock preflight proof does not match remote readiness");
  }
  if (receipt.remoteReadiness !== undefined) {
    verifyHostedRemoteReadinessV1(receipt.remoteReadiness);
  }
  return Object.freeze({
    ...receipt,
    ...(receipt.remoteReadiness === undefined ? {} : { remoteReadiness: receipt.remoteReadiness }),
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

export function assertHostedCampaignPlanMatchesDefinitionAndBindings(
  definitionValue: unknown,
  bindingsValue: unknown,
  planValue: unknown,
): ReturnType<typeof parseHostedCampaignPlan> {
  const definition = hostedCampaignDefinitionV1Schema.parse(definitionValue);
  const bindings = hostedCampaignRuntimeBindingsV1Schema.parse(bindingsValue);
  const plan = parseHostedCampaignPlan(planValue);
  const compiledPlan = buildResolvedHostedCampaignPlanV1(definition, bindings);
  if (digestCanonical(plan) !== digestCanonical(compiledPlan)) {
    throw new Error("Hosted campaign plan does not match the definition and bindings");
  }
  return parseHostedCampaignPlan(compiledPlan);
}

export interface HostedCampaignFreshAuthorizationRequest {
  readonly bindings: unknown;
  readonly deadlineEpochMs: number;
  readonly definition: unknown;
  readonly minimumHeadroomMs: number;
  readonly now: () => number;
  readonly plan: unknown;
  readonly remoteAdmissionProbe: HostedCampaignRemoteAdmissionProbe | undefined;
  readonly signal: AbortSignal;
}

export interface HostedCampaignLaunchAuthorization {
  /** Synchronous final fence. Invoke immediately before the first spawn. */
  assertReadyForFirstChild(): void;
  readonly clockPreflightProof: HostedClockPreflightReceiptV2;
}

export async function authorizeHostedCampaignLaunch(
  request: HostedCampaignFreshAuthorizationRequest,
): Promise<HostedCampaignLaunchAuthorization> {
  if (!Number.isSafeInteger(request.minimumHeadroomMs) || request.minimumHeadroomMs < 5_000) {
    throw new Error("Hosted campaign launch authorization requires at least 5000ms headroom");
  }
  assertFreshAuthorizationActive(request);
  const definition = hostedCampaignDefinitionV1Schema.parse(request.definition);
  const plan = assertHostedCampaignPlanMatchesDefinitionAndBindings(
    definition, request.bindings, request.plan,
  );
  const evaluation = await evaluateHostedRemoteAdmission(request.remoteAdmissionProbe === undefined
    ? undefined
    : Object.freeze({
        ...request.remoteAdmissionProbe,
        inspect: async (expected: HostedCampaignRemoteAdmissionProbeRequest) =>
          request.remoteAdmissionProbe!.inspect(expected, request.signal),
      }), {
    campaignId: definition.campaignId,
    meetingPlatformRevision: definition.revisions.meetingPlatform,
    planSha256: digestCanonical(plan),
  }, request.now);
  assertFreshAuthorizationActive(request);
  if (evaluation.missingSections.length !== 0 || evaluation.readiness === undefined
    || evaluation.clockPreflightProof === undefined) {
    throw new Error("Hosted campaign fresh remote authorization is incomplete");
  }
  const readiness = evaluation.readiness;
  const authorizedPlanSha256 = digestCanonical(plan);
  if (readiness.campaignId !== definition.campaignId
    || readiness.planSha256 !== authorizedPlanSha256
    || readiness.clockPreflight.proofId !== evaluation.clockPreflightProof.proofId) {
    throw new Error("Hosted campaign fresh remote authorization is not bound to this launch");
  }
  const expiresAtEpochMs = Math.min(
    Date.parse(readiness.expiresAt), evaluation.clockPreflightProof.validUntilEpochMs,
  );
  const assertReadyForFirstChild = (): void => {
    assertFreshAuthorizationActive(request);
    const nowEpochMs = request.now();
    if (!Number.isSafeInteger(nowEpochMs) || !Number.isSafeInteger(expiresAtEpochMs)
      || expiresAtEpochMs - nowEpochMs < request.minimumHeadroomMs) {
      throw new Error("Hosted campaign fresh remote authorization lacks launch headroom");
    }
  };
  assertReadyForFirstChild();
  return Object.freeze({
    assertReadyForFirstChild,
    clockPreflightProof: evaluation.clockPreflightProof,
  });
}

function assertFreshAuthorizationActive(request: HostedCampaignFreshAuthorizationRequest): void {
  if (request.signal.aborted) {
    throw request.signal.reason ?? new Error("Hosted campaign fresh authorization was cancelled");
  }
  const nowEpochMs = request.now();
  if (!Number.isSafeInteger(request.deadlineEpochMs) || !Number.isSafeInteger(nowEpochMs)
    || request.deadlineEpochMs - nowEpochMs < request.minimumHeadroomMs) {
    throw new Error("Hosted campaign deadline lacks fresh authorization headroom");
  }
}

/**
 * Verifies the persisted receipt as immutable audit evidence only. Launch
 * authority is deliberately excluded: the runner must obtain fresh remote
 * authorization after acquiring its campaign lease.
 */
export function assertAdmissionAuditMatchesInvocation(
  invocation: HostedCampaignAdmissionInvocation,
): HostedCampaignAdmissionReceiptV1 {
  return assertAdmissionReceiptBindings(invocation, false);
}

export function assertAdmissionMatchesInvocation(
  invocation: HostedCampaignAdmissionInvocation,
): HostedCampaignAdmissionReceiptV1 {
  return assertAdmissionReceiptBindings(invocation, true);
}

function assertAdmissionReceiptBindings(
  invocation: HostedCampaignAdmissionInvocation,
  requireLiveReadiness: boolean,
): HostedCampaignAdmissionReceiptV1 {
  const receipt = verifyHostedCampaignAdmissionReceipt(invocation.receipt);
  const definition = hostedCampaignDefinitionV1Schema.parse(invocation.definition);
  const bindings = hostedCampaignRuntimeBindingsV1Schema.parse(invocation.bindings);
  const plan = assertHostedCampaignPlanMatchesDefinitionAndBindings(definition, bindings, invocation.plan);
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
  if (requireLiveReadiness) {
    assertRemoteReadinessMatchesInvocation(receipt, invocation.nowEpochMs);
  }
  return receipt;
}

async function evaluateRemote(
  request: HostedCampaignAdmissionRequest,
  campaignId: string,
  plan: unknown,
  now: () => number,
) {
  return evaluateHostedRemoteAdmission(
    request.remoteAdmissionProbe,
    {
      campaignId, meetingPlatformRevision: hostedCampaignDefinitionV1Schema.parse(request.definition)
        .revisions.meetingPlatform,
      planSha256: digestCanonical(plan),
    },
    now,
  );
}

function resolveAdmissionTime(
  readiness: HostedRemoteReadinessV1 | undefined,
  now: () => number,
): number {
  const generatedAtEpochMs = readiness === undefined ? now() : Date.parse(readiness.probedAt);
  if (!Number.isSafeInteger(generatedAtEpochMs)) {
    throw new Error("Hosted campaign admission clock is invalid");
  }
  return generatedAtEpochMs;
}

function assertRemoteReadinessMatchesInvocation(
  receipt: HostedCampaignAdmissionReceiptV1,
  nowEpochMs: number,
): void {
  const readiness = receipt.remoteReadiness;
  if (readiness === undefined || readiness.campaignId !== receipt.campaignId
    || readiness.planSha256 !== receipt.planSha256 || Date.parse(readiness.probedAt) > nowEpochMs
    || Date.parse(readiness.expiresAt) <= nowEpochMs) {
    throw new Error("Hosted campaign remote readiness is not live for this invocation");
  }
  if (receipt.clockPreflightProof === undefined
    || readiness.clockPreflight.proofId !== receipt.clockPreflightProof.proofId
    || receipt.clockPreflightProof.validUntilEpochMs <= nowEpochMs) {
    throw new Error("Hosted campaign clock preflight proof is not live for this invocation");
  }
}

function assertSpeakerFixturePaths(
  fixtures: Readonly<{ a: string; b: string }>,
  expectedPaths: readonly (string | undefined)[],
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
