import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { BoundedDiscordBotJsonClient } from "./hosted-discord-identity-http.js";
import { DiscordRestRoleIdentityProbe } from "./hosted-discord-identity-producer.js";
import type { HostedRemoteAdmissionCompositionConfig } from "./hosted-remote-admission-composition.js";
import { HostedRemoteVoicetextCanaryRunnerV1 } from "./hosted-remote-voicetext-canary-runner.js";
import type { HostedCampaignProductionCandidate } from "./hosted-campaign-production-policy.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-target.js";
import { HOSTED_VOICETEXT_CANARY_BINDING_V1 } from "./hosted-voicetext-canary-binding.js";
import { SshHostedServiceLevelRawProbe } from "./hosted-service-level-raw-probe.js";
import { createConcreteSshDeploymentSafetyProbe } from "./ssh-deployment-safety-probe-factory.js";
import { SshRemoteContainerProcessAdapter } from "./ssh-remote-container-process-adapter.js";
import { FileSecretReader } from "./keychain.js";
import { GENERATED_HOSTED_CAMPAIGN_COMPILED_RELEASE } from
  "./hosted-campaign-compiled-release.generated.js";
import { hostedCraigNetworkPolicyV1Schema } from "./hosted-deployment-safety-receipt.js";

const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const sourceRevision = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const containerId = z.string().regex(/^[a-f\d]{64}$/u);
const imageId = z.string().regex(/^sha256:[a-f\d]{64}$/u);
const repositoryDigest = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);
const absolutePath = z.string().startsWith("/").refine((value) => !value.includes("\0") && !value.includes("/../"));
const serviceComponent = z.enum(["craig", "meetingPlatform", "pipecat", "subscriptionRuntime"]);
const transcriptSegment = z.object({
  endMs: z.number().int().nonnegative(), startMs: z.number().int().nonnegative(), text: z.string().min(1),
}).strict().refine(({ endMs, startMs }) => endMs >= startMs);
const service = z.object({
  component: serviceComponent,
  composeProject: z.enum([HOSTED_CAMPAIGN_TARGET.project, HOSTED_CAMPAIGN_TARGET.craigProject]),
  composeService: z.enum(["bot", "meeting-platform", "pipecat-runtime", "subscription-runtime-sidecar"]),
  containerId,
  imageId,
  repositoryDigest,
  sourceRevision,
}).strict();

export const hostedCampaignReleaseBindingV1Schema = z.object({
  canary: z.object({
    endpoint: z.object({
      batch: z.object({ origin: z.url(), path: z.string().startsWith("/") }).strict(),
      live: z.object({ origin: z.url(), path: z.string().startsWith("/") }).strict(),
    }).strict(),
    fixturePath: absolutePath,
    fixtureSha256: sha256,
    requiredTerms: z.array(z.string().min(1)).min(1).max(256),
  }).strict(),
  releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  schemaVersion: z.literal(1),
  services: z.array(service).length(4),
  trustRootSha256: sha256,
}).strict().superRefine((value, context) => {
  if (new Set(value.services.map(({ component }) => component)).size !== 4) {
    context.addIssue({ code: "custom", message: "Release binding must declare each service exactly once" });
  }
});

export const hostedCampaignReleaseTrustRootV1Schema = z.object({
  allowedNetworks: z.array(z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/u)).min(1),
  campaignRoot: absolutePath,
  campaignRootOwnerGid: z.literal(10_001),
  campaignRootOwnerUid: z.literal(10_001),
  canary: z.object({
    endpoint: hostedCampaignReleaseBindingV1Schema.shape.canary.shape.endpoint,
    fixturePath: absolutePath,
    fixtureSha256: sha256,
    maximumCharacterErrorRate: z.number().min(0).lt(1),
    maximumTimelineDeltaMs: z.number().int().nonnegative().max(60_000),
    maximumWordErrorRate: z.number().min(0).lt(1),
    requiredTerms: z.array(z.string().min(1)).min(1).max(256),
    transcriptExpectationSha256: sha256,
    expectedSegments: z.array(transcriptSegment).min(1).max(1_024),
  }).strict(),
  clockMaximumSkewMs: z.number().int().nonnegative().max(60_000),
  craigNetworkPolicy: hostedCraigNetworkPolicyV1Schema,
  deployRoot: absolutePath,
  discordReceiptTtlMs: z.number().int().positive().max(60_000),
  environmentFile: absolutePath,
  host: z.literal(HOSTED_CAMPAIGN_TARGET.host),
  remoteComposeFile: absolutePath,
  schemaVersion: z.literal(2),
  secretDirectory: absolutePath,
  services: z.array(service.omit({ containerId: true })).length(4),
  sourceRoot: absolutePath,
  voicetextReceiptTtlMs: z.number().int().positive().max(60_000),
  voicetextTimeoutMs: z.number().int().positive().max(300_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.services.map(({ component }) => component)).size !== 4) {
    context.addIssue({ code: "custom", message: "Release trust root must pin each service exactly once" });
  }
  if (!matchesPinnedVoicetextCanary(value.canary)) {
    context.addIssue({ code: "custom", message: "Release trust root must match the committed Voicetext canary binding" });
  }
});

export type HostedCampaignReleaseTrustRootV1 = z.infer<typeof hostedCampaignReleaseTrustRootV1Schema>;

/**
 * Only build-generated, source-literal trust can authorize production. Runtime
 * environment values and the operator release binding cannot populate it.
 */
export const COMPILED_HOSTED_CAMPAIGN_RELEASE_TRUST_ROOT =
  resolveCompiledHostedCampaignReleaseTrustRoot(
    GENERATED_HOSTED_CAMPAIGN_COMPILED_RELEASE,
  );

export function digestHostedCampaignReleaseTrustRootV1(value: HostedCampaignReleaseTrustRootV1): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function resolveCompiledHostedCampaignReleaseTrustRoot(
  generated: unknown,
): HostedCampaignReleaseTrustRootV1 | undefined {
  if (!isRecord(generated) || generated.schemaVersion !== 1 ||
    generated.generatorVersion !== 1) {
    throw new Error("Compiled hosted campaign release metadata is malformed");
  }
  if (generated.status === "unadmitted") {
    if (Object.keys(generated).length !== 3) {
      throw new Error("Unadmitted compiled release must not contain trust material");
    }
    return undefined;
  }
  if (generated.status !== "admitted" || Object.keys(generated).length !== 5 ||
    typeof generated.trustRootSha256 !== "string") {
    throw new Error("Compiled hosted campaign release admission is malformed");
  }
  const trustRoot = hostedCampaignReleaseTrustRootV1Schema.parse(generated.trustRoot);
  if (digestHostedCampaignReleaseTrustRootV1(trustRoot) !== generated.trustRootSha256) {
    throw new Error("Compiled hosted campaign release trust-root digest is invalid");
  }
  return Object.freeze(trustRoot);
}

function digestHostedCampaignReleaseBindingV1(value: unknown): string {
  return digestCanonical(hostedCampaignReleaseBindingV1Schema.parse(value));
}

export function admitCompiledHostedCampaignReleaseBinding(
  candidateValue: unknown,
  trustRoot: HostedCampaignReleaseTrustRootV1 | undefined =
    COMPILED_HOSTED_CAMPAIGN_RELEASE_TRUST_ROOT,
): Readonly<{
  readonly release: z.infer<typeof hostedCampaignReleaseBindingV1Schema>;
  readonly releaseReference: {
    readonly releaseBindingSha256: string;
    readonly releaseId: string;
    readonly trustRootSha256: string;
  };
}> {
  if (trustRoot === undefined) {
    throw new Error("A build-admitted compiled hosted campaign release is required");
  }
  const release = hostedCampaignReleaseBindingV1Schema.parse(candidateValue);
  if (release.trustRootSha256 !== digestHostedCampaignReleaseTrustRootV1(trustRoot)) {
    throw new Error("Release binding does not select the compiled trust root");
  }
  assertReleaseMatchesTrustRoot(release, trustRoot);
  return Object.freeze({
    release,
    releaseReference: Object.freeze({
      releaseBindingSha256: digestHostedCampaignReleaseBindingV1(release),
      releaseId: release.releaseId,
      trustRootSha256: release.trustRootSha256,
    }),
  });
}

export function createHostedCampaignReleaseConfig(
  candidateValue: unknown,
  trustRootValue: unknown,
  campaign: HostedCampaignProductionCandidate,
  now: () => number = Date.now,
): HostedRemoteAdmissionCompositionConfig {
  const release = hostedCampaignReleaseBindingV1Schema.parse(candidateValue);
  const trust = hostedCampaignReleaseTrustRootV1Schema.parse(trustRootValue);
  if (release.trustRootSha256 !== digestHostedCampaignReleaseTrustRootV1(trust)) {
    throw new Error("Release binding does not select the compiled trust root");
  }
  assertReleaseMatchesTrustRoot(release, trust);
  const definition = campaign.definition as {
    campaignRoot: string; remote: { composeFile: string; environmentFile: string; sourceRoot: string };
    revisions: Record<"craig" | "meetingPlatform" | "pipecat" | "subscriptionRuntime", string>;
    runIds: readonly [string, string, string]; secretDirectory: string;
  };
  if (definition.campaignRoot !== trust.campaignRoot
    || definition.remote.composeFile !== trust.remoteComposeFile
    || definition.remote.environmentFile !== trust.environmentFile
    || definition.remote.sourceRoot !== trust.sourceRoot
    || definition.secretDirectory !== trust.secretDirectory) {
    throw new Error("Campaign definition does not match the compiled release paths");
  }
  const byComponent = new Map(release.services.map((entry) => [entry.component, entry]));
  for (const component of ["craig", "meetingPlatform", "pipecat", "subscriptionRuntime"] as const) {
    if (byComponent.get(component)?.sourceRevision !== definition.revisions[component]) {
      throw new Error(`Campaign ${component} revision does not match the release binding`);
    }
  }
  const platform = requiredService(byComponent, "meetingPlatform");
  const craig = requiredService(byComponent, "craig");
  const campaignSource = `${definition.campaignRoot}/${campaign.campaignId}`;
  const greetingRunSource = `${campaignSource}/run-3`;
  const campaignContainerRoot = `/run/e2e-campaign/${campaign.campaignId}`;
  const greetingRunContainerRoot = `${campaignContainerRoot}/run-3`;
  const expectation = {
    allowedNetworks: trust.allowedNetworks,
    campaignId: campaign.campaignId,
    campaignRoot: trust.campaignRoot,
    campaignRootOwnerGid: trust.campaignRootOwnerGid,
    campaignRootOwnerUid: trust.campaignRootOwnerUid,
    craigNetworkPolicy: trust.craigNetworkPolicy,
    deployRoot: trust.deployRoot,
    greeting: {
      campaignSiblingPath: `${definition.campaignRoot}-sibling`,
      destinationPath: "/run/e2e-campaign",
      environmentRoot: `${greetingRunContainerRoot}/greeting-handshakes`,
      observerRoot: `${greetingRunSource}/greeting-handshakes`,
      runRoot: greetingRunSource,
      runSiblingPath: `${campaignSource}/run-2`,
      sourcePath: definition.campaignRoot,
    },
    services: release.services,
    sourceRoot: trust.sourceRoot,
  } as const;
  const ssh = {
    composeFile: trust.remoteComposeFile,
    craigProjectName: HOSTED_CAMPAIGN_TARGET.craigProject,
    craigServiceName: "bot",
    envFile: trust.environmentFile,
    host: trust.host,
    mutationTarget: HOSTED_CAMPAIGN_TARGET.mutationTarget,
    projectName: HOSTED_CAMPAIGN_TARGET.project,
    sourceRoot: trust.sourceRoot,
  } as const;
  const remoteProcess = new SshRemoteContainerProcessAdapter();
  const secrets = new FileSecretReader(trust.secretDirectory);
  const localProbe = (account: "conversation-observer" | "speaker-a" | "speaker-b" | "speaker-d" | "sut") => ({
    expectation: {
      applicationId: applicationIdFor(account),
      tokenFile: { account, ownerUid: process.getuid?.() ?? -1, path: `${trust.secretDirectory}/${account}`, scope: "local-campaign-secret" as const },
    },
    probe: new DiscordRestRoleIdentityProbe(secrets, new BoundedDiscordBotJsonClient()),
  });
  const binding = {
    campaignId: campaign.campaignId, containerId: platform.containerId, host: trust.host,
    imageDigestSha256: digestFromRepository(platform.repositoryDigest),
    planSha256: campaign.planSha256, sourceRevision: platform.sourceRevision,
  };
  return {
    campaignId: campaign.campaignId,
    clock: Object.assign(new SshHostedServiceLevelRawProbe({
      composeFile: trust.remoteComposeFile, craigProjectName: HOSTED_CAMPAIGN_TARGET.craigProject,
      craigServiceName: "bot", environmentFile: trust.environmentFile, host: trust.host,
      mutationTarget: "test-only", projectName: HOSTED_CAMPAIGN_TARGET.project, sourceRoot: trust.sourceRoot,
    }), { maximumClockSkewBoundMs: trust.clockMaximumSkewMs }),
    craig: { containerId: craig.containerId, imageDigestSha256: digestFromRepository(craig.repositoryDigest), sourceRevision: craig.sourceRevision },
    deployment: {
      expectation,
      producer: createConcreteSshDeploymentSafetyProbe({
        containerNonce: randomUUID(), expectation, generatedAt: () => new Date(now()).toISOString(),
        hostNonce: randomUUID(), ssh,
      }),
    },
    discord: {
      binding, now,
      roles: { localObserver: localProbe("conversation-observer"), localSpeakerA: localProbe("speaker-a"),
        localSpeakerB: localProbe("speaker-b"), localSpeakerD: localProbe("speaker-d"), localSut: localProbe("sut") },
      target: { deploymentScope: HOSTED_CAMPAIGN_TARGET.deploymentScope, environment: HOSTED_CAMPAIGN_TARGET.environment,
        guildId: HOSTED_CAMPAIGN_TARGET.guildId, mutationTarget: HOSTED_CAMPAIGN_TARGET.mutationTarget,
        publicationChannelId: HOSTED_CAMPAIGN_TARGET.publicationChannelId, voiceChannelId: HOSTED_CAMPAIGN_TARGET.voiceChannelId },
      ttlMs: trust.discordReceiptTtlMs,
    },
    meetingPlatformRevision: campaign.meetingPlatformRevision,
    planSha256: campaign.planSha256,
    remoteContainerProcess: remoteProcess,
    voicetext: {
      fixtureExpectation: { maximumCharacterErrorRate: trust.canary.maximumCharacterErrorRate,
        maximumTimelineDeltaMs: trust.canary.maximumTimelineDeltaMs, maximumWordErrorRate: trust.canary.maximumWordErrorRate },
      input: { binding: { ...binding, fixtureSha256: release.canary.fixtureSha256,
        transcriptExpectationSha256: trust.canary.transcriptExpectationSha256 },
      endpoint: release.canary.endpoint, expectedSegments: trust.canary.expectedSegments,
      fixturePath: release.canary.fixturePath, now, requiredTerms: release.canary.requiredTerms,
      timeoutMs: trust.voicetextTimeoutMs, ttlMs: trust.voicetextReceiptTtlMs },
      runner: new HostedRemoteVoicetextCanaryRunnerV1(remoteProcess),
    },
  };
}

function matchesPinnedVoicetextCanary(canary: z.infer<typeof hostedCampaignReleaseTrustRootV1Schema>["canary"]): boolean {
  const pinned = HOSTED_VOICETEXT_CANARY_BINDING_V1;
  return canary.fixturePath === pinned.fixture.audioPath
    && canary.fixtureSha256 === pinned.fixture.audioSha256
    && canary.maximumCharacterErrorRate === pinned.fixtureExpectation.maximumCharacterErrorRate
    && canary.maximumTimelineDeltaMs === pinned.fixtureExpectation.maximumTimelineDeltaMs
    && canary.maximumWordErrorRate === pinned.fixtureExpectation.maximumWordErrorRate
    && canary.transcriptExpectationSha256 === pinned.transcriptExpectation.sha256
    && JSON.stringify(canonical(canary.endpoint)) === JSON.stringify(canonical(pinned.endpoint))
    && JSON.stringify(canonical(canary.requiredTerms)) === JSON.stringify(canonical(pinned.requiredTerms))
    && JSON.stringify(canonical(canary.expectedSegments)) === JSON.stringify(canonical(pinned.transcriptExpectation.segments))
    && digestCanonical(canary.expectedSegments) === canary.transcriptExpectationSha256;
}

function assertReleaseMatchesTrustRoot(
  release: z.infer<typeof hostedCampaignReleaseBindingV1Schema>,
  trust: HostedCampaignReleaseTrustRootV1,
): void {
  const trusted = new Map(trust.services.map((entry) => [entry.component, entry]));
  for (const { containerId: _containerId, ...identity } of release.services) {
    if (JSON.stringify(canonical(identity)) !== JSON.stringify(canonical(trusted.get(identity.component)))) {
      throw new Error(`Release ${identity.component} identity is not allowed by the compiled trust root`);
    }
  }
  const canary = release.canary;
  if (canary.fixturePath !== trust.canary.fixturePath || canary.fixtureSha256 !== trust.canary.fixtureSha256
    || JSON.stringify(canonical(canary.endpoint)) !== JSON.stringify(canonical(trust.canary.endpoint))
    || JSON.stringify(canonical(canary.requiredTerms)) !== JSON.stringify(canonical(trust.canary.requiredTerms))) {
    throw new Error("Release canary is not allowed by the compiled trust root");
  }
}

function requiredService(map: ReadonlyMap<string, z.infer<typeof service>>, component: z.infer<typeof serviceComponent>) {
  const value = map.get(component);
  if (value === undefined) { throw new Error(`Release binding is missing ${component}`); }
  return value;
}

function applicationIdFor(account: "conversation-observer" | "speaker-a" | "speaker-b" | "speaker-d" | "sut"): string {
  return ({ "conversation-observer": HOSTED_CAMPAIGN_TARGET.observerApplicationId,
    "speaker-a": HOSTED_CAMPAIGN_TARGET.speakerAApplicationId, "speaker-b": HOSTED_CAMPAIGN_TARGET.speakerBApplicationId,
    "speaker-d": HOSTED_CAMPAIGN_TARGET.speakerDApplicationId, sut: HOSTED_CAMPAIGN_TARGET.sutApplicationId })[account];
}

function digestFromRepository(value: string): string { return value.slice(value.lastIndexOf("@sha256:") + 8); }
function digestCanonical(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(canonical); }
  if (value === null || typeof value !== "object") { return value; }
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonical(nested)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
