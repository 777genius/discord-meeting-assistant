import { isAbsolute, join, normalize, relative } from "node:path";

import { z } from "zod";

import {
  HOSTED_CAMPAIGN_TARGET,
  type HostedCampaignActionReference,
  type HostedCampaignBarrierAction,
  type HostedCampaignExecutableSpec,
  type HostedCampaignInput,
  type HostedCampaignRun,
  validateHostedCampaign,
} from "./hosted-campaign-coordinator.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const absolutePath = z.string().refine((value) => isAbsolute(value) && normalize(value) !== "/");
const sourceRevision = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const httpsOrigin = z.url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" && parsed.origin === value;
});

export const hostedCampaignDefinitionV1Schema = z.object({
  answerFirstPacketMilliseconds: z.number().int().safe().positive(),
  campaignId: identifier,
  campaignRoot: absolutePath,
  fixtureManifestPath: absolutePath,
  recordingPlaybackOrigin: httpsOrigin,
  remote: z.object({
    composeFile: absolutePath,
    environmentFile: absolutePath,
    sourceRoot: absolutePath,
  }).strict(),
  revisions: z.object({
    craig: sourceRevision,
    meetingPlatform: sourceRevision,
    pipecat: sourceRevision,
    subscriptionRuntime: sourceRevision,
  }).strict(),
  runIds: z.tuple([identifier, identifier, identifier]),
  schemaVersion: z.literal(1),
  secretDirectory: absolutePath,
  serviceLevelThresholdsPath: absolutePath,
  supplementalManifestPath: absolutePath,
}).strict().superRefine((value, context) => {
  if (new Set(value.runIds).size !== 3) {
    context.addIssue({ code: "custom", message: "Hosted campaign definition runIds must be unique", path: ["runIds"] });
  }
});

export type HostedCampaignDefinitionV1 = z.infer<typeof hostedCampaignDefinitionV1Schema>;

const bindingSchema = z.object({
  recordingId: identifier,
  remoteAttestationPath: z.string().regex(
    /^\/tmp\/discord-e2e-attestations\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u,
  ),
}).strict();

export const hostedCampaignRuntimeBindingsV1Schema = z.object({
  runs: z.tuple([bindingSchema, bindingSchema, bindingSchema]),
  schemaVersion: z.literal(1),
}).strict();

export type HostedCampaignRuntimeBindingsV1 = z.infer<typeof hostedCampaignRuntimeBindingsV1Schema>;

export type HostedCampaignRequiredBindingV1 = Readonly<{
  key: `runs.${0 | 1 | 2}.${"recordingId" | "remoteAttestationPath"}`;
  source: "authoritative-recording-ready-receipt" | "operator-reviewed-replay-attestation";
}>;

export type HostedCampaignPlanCompilationV1 =
  | Readonly<{
      blockedReasons: readonly ["DYNAMIC_RUNTIME_BINDINGS_REQUIRED"];
      requiredBindings: readonly HostedCampaignRequiredBindingV1[];
      schemaVersion: 1;
      status: "blocked";
    }>
  | Readonly<{ plan: HostedCampaignInput; schemaVersion: 1; status: "ready" }>;

const requiredBindings: readonly HostedCampaignRequiredBindingV1[] = Object.freeze([
  { key: "runs.0.recordingId", source: "authoritative-recording-ready-receipt" },
  { key: "runs.0.remoteAttestationPath", source: "operator-reviewed-replay-attestation" },
  { key: "runs.1.recordingId", source: "authoritative-recording-ready-receipt" },
  { key: "runs.1.remoteAttestationPath", source: "operator-reviewed-replay-attestation" },
  { key: "runs.2.recordingId", source: "authoritative-recording-ready-receipt" },
  { key: "runs.2.remoteAttestationPath", source: "operator-reviewed-replay-attestation" },
]);

export function compileHostedCampaignDefinitionV1(
  definitionValue: unknown,
  bindingsValue?: unknown,
): HostedCampaignPlanCompilationV1 {
  const definition = hostedCampaignDefinitionV1Schema.parse(definitionValue);
  if (bindingsValue === undefined) {
    return Object.freeze({
      blockedReasons: ["DYNAMIC_RUNTIME_BINDINGS_REQUIRED"] as const,
      requiredBindings,
      schemaVersion: 1,
      status: "blocked",
    });
  }
  const bindings = hostedCampaignRuntimeBindingsV1Schema.parse(bindingsValue);
  const plan = buildResolvedHostedCampaignPlanV1(definition, bindings);
  validateHostedCampaign(plan);
  return Object.freeze({ plan, schemaVersion: 1, status: "ready" });
}

export function buildResolvedHostedCampaignPlanV1(
  definitionValue: unknown,
  bindingsValue: unknown,
): HostedCampaignInput {
  const definition = hostedCampaignDefinitionV1Schema.parse(definitionValue);
  const bindings = hostedCampaignRuntimeBindingsV1Schema.parse(bindingsValue);
  const paths = campaignPaths(definition.campaignRoot, definition.campaignId);
  const runs = makeRuns(definition);
  const children = makeChildren(definition, bindings, runs, paths);
  const plan = Object.freeze({
    children: Object.freeze(children),
    runs,
    target: HOSTED_CAMPAIGN_TARGET,
    thresholds: Object.freeze({ answerFirstPacketMilliseconds: definition.answerFirstPacketMilliseconds }),
  });
  validateHostedCampaign(plan);
  return plan;
}

interface CampaignPaths {
  readonly artifactRoot: string;
  readonly campaignManifest: string;
  readonly campaignProof: string;
  readonly provenanceSnapshot: string;
  readonly run: (ordinal: 1 | 2 | 3, leaf: string) => string;
}

function campaignPaths(root: string, campaignId: string): CampaignPaths {
  const ownedRoot = safeJoin(root, campaignId);
  return Object.freeze({
    artifactRoot: safeJoin(ownedRoot, "barriers"),
    campaignManifest: safeJoin(ownedRoot, "campaign-manifest.json"),
    campaignProof: safeJoin(ownedRoot, "campaign-proof.json"),
    provenanceSnapshot: safeJoin(ownedRoot, "provenance.json"),
    run: (ordinal: 1 | 2 | 3, leaf: string) => safeJoin(ownedRoot, `run-${ordinal}`, leaf),
  });
}

function safeJoin(root: string, ...parts: readonly string[]): string {
  const normalizedRoot = normalize(root);
  const candidate = normalize(join(normalizedRoot, ...parts));
  const relation = relative(normalizedRoot, candidate);
  if (relation === "" || relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Hosted campaign path escaped or replaced its owned root");
  }
  return candidate;
}

type FixedHostedCampaignRun<Ordinal extends 1 | 2 | 3> = HostedCampaignRun & { readonly ordinal: Ordinal };

function makeRuns(definition: HostedCampaignDefinitionV1): readonly [
  FixedHostedCampaignRun<1>, FixedHostedCampaignRun<2>, FixedHostedCampaignRun<3>,
] {
  return Object.freeze([
    Object.freeze({ campaignId: definition.campaignId, ordinal: 1, retainedCaptureCount: 0, runId: definition.runIds[0], scenario: "sequential" }),
    Object.freeze({ campaignId: definition.campaignId, ordinal: 2, retainedCaptureCount: 0, runId: definition.runIds[1], scenario: "overlap" }),
    Object.freeze({ campaignId: definition.campaignId, ordinal: 3, retainedCaptureCount: 6, runId: definition.runIds[2], scenario: "reconnect" }),
  ]);
}

function reference(run: HostedCampaignRun, action: HostedCampaignActionReference["action"]): HostedCampaignActionReference {
  return { action, ordinal: run.ordinal, runId: run.runId };
}

function runVerifiedReference(
  run: HostedCampaignRun,
): HostedCampaignActionReference & {
  readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "run-verified" }>;
} {
  return { action: { kind: "run-verified", ordinal: run.ordinal, runId: run.runId }, ordinal: run.ordinal, runId: run.runId };
}

function provenanceReference(
  run: HostedCampaignRun,
  phase: "after" | "before",
): HostedCampaignActionReference & {
  readonly action: { readonly kind: "provenance-after" | "provenance-before" };
} {
  return { action: { kind: phase === "before" ? "provenance-before" : "provenance-after" }, ordinal: run.ordinal, runId: run.runId };
}

function produced(run: HostedCampaignRun, action: HostedCampaignActionReference["action"], outputPath: string) {
  return { ...reference(run, action), outputPath };
}

function makeChildren(
  definition: HostedCampaignDefinitionV1,
  bindings: HostedCampaignRuntimeBindingsV1,
  runs: readonly [FixedHostedCampaignRun<1>, FixedHostedCampaignRun<2>, FixedHostedCampaignRun<3>],
  paths: CampaignPaths,
): readonly HostedCampaignExecutableSpec[] {
  const [sequential, overlap, reconnect] = runs;
  const [sequentialBinding, overlapBinding, reconnectBinding] = bindings.runs;
  const provenanceBefore = provenanceReference(sequential, "before");
  const observerSubscribed = reference(sequential, { kind: "observer-subscribed" });
  const runVerified = runs.map(runVerifiedReference);
  const provenanceAfter = provenanceReference(reconnect, "after");
  const campaignVerified = reference(reconnect, { kind: "campaign-verified" });
  const revisions = {
    DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION: definition.revisions.craig,
    DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION: definition.revisions.meetingPlatform,
    DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION: definition.revisions.pipecat,
    DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION: definition.revisions.subscriptionRuntime,
  };
  const remote = {
    DISCORD_E2E_MUTATION_TARGET: HOSTED_CAMPAIGN_TARGET.mutationTarget,
    DISCORD_E2E_REMOTE_COMPOSE_FILE: definition.remote.composeFile,
    DISCORD_E2E_REMOTE_CRAIG_PROJECT: HOSTED_CAMPAIGN_TARGET.craigProject,
    DISCORD_E2E_REMOTE_CRAIG_SERVICE: "bot",
    DISCORD_E2E_REMOTE_ENV_FILE: definition.remote.environmentFile,
    DISCORD_E2E_REMOTE_HOST: HOSTED_CAMPAIGN_TARGET.host,
    DISCORD_E2E_REMOTE_PROJECT: HOSTED_CAMPAIGN_TARGET.project,
    DISCORD_E2E_REMOTE_SOURCE_ROOT: definition.remote.sourceRoot,
  };
  const barrierPath = (name: string) => safeJoin(paths.artifactRoot, `${name}.json`);
  const provenance = (
    phase: "before" | "after",
    run: HostedCampaignRun,
    start: HostedCampaignActionReference & { readonly action: { readonly kind: "provenance-before" | "provenance-after" } },
  ): HostedCampaignExecutableSpec => ({
    arguments: { kind: "environment" }, childId: `provenance-${phase}`,
    completion: {
      action: start.action, campaignId: definition.campaignId,
      kind: "provenance-probe", phase, runIds: definition.runIds, snapshotPath: paths.provenanceSnapshot,
    },
    entrypoint: "provenance-probe", environment: {
      ...remote, ...revisions, DISCORD_E2E_PROVENANCE_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_PROVENANCE_PHASE: phase, DISCORD_E2E_PROVENANCE_RUN_IDS_JSON: JSON.stringify(definition.runIds),
      DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH: paths.provenanceSnapshot,
    }, produces: [produced(run, start.action, barrierPath(`provenance-${phase}`))], requires: phase === "after" ? [runVerified[2]!] : [],
    startBefore: { ...start, kind: "barrier" },
  });
  const liveObserver: HostedCampaignExecutableSpec = {
    arguments: { kind: "environment" }, childId: "live-observer", entrypoint: "live-observer",
    environment: {
      DISCORD_E2E_LIVE_DURATION_MS: "600000", DISCORD_E2E_LIVE_OUTPUT: paths.run(1, "live-discord.json"),
      DISCORD_E2E_LIVE_POLL_INTERVAL_MS: "2000", DISCORD_E2E_LIVE_RESULT_CHANNEL_ID: HOSTED_CAMPAIGN_TARGET.publicationChannelId,
      DISCORD_E2E_LIVE_RUN_ID: sequential.runId, DISCORD_E2E_LIVE_SECRET_DIRECTORY: definition.secretDirectory,
      DISCORD_E2E_LIVE_SUT_APPLICATION_ID: HOSTED_CAMPAIGN_TARGET.sutApplicationId,
    }, produces: [produced(sequential, observerSubscribed.action, barrierPath("observer-subscribed"))],
    requires: [], startBefore: { kind: "campaign" },
  };
  const reconnectActions = [
    ...Array.from({ length: 4 }, (_, index) => reference(reconnect, { kind: "capture-retained", ordinal: index + 1 })),
    reference(reconnect, { kind: "reconnect-left" }), reference(reconnect, { kind: "reconnect-ready" }),
    reference(reconnect, { kind: "answer-intent" }), reference(reconnect, { kind: "answer-observer-ready" }),
    reference(reconnect, { kind: "answer-first-packet" }),
    reference(reconnect, { kind: "capture-retained", ordinal: 5 }), reference(reconnect, { kind: "capture-retained", ordinal: 6 }),
  ];
  const conversationObserver: HostedCampaignExecutableSpec = {
    arguments: { kind: "environment" }, childId: "conversation-observer", entrypoint: "conversation-observer",
    environment: {
      DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID: `${reconnect.runId}:capture-1`,
      DISCORD_E2E_CONVERSATION_VOICE_CAMPAIGN_PROOF_OUTPUT: paths.campaignProof,
      DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID: HOSTED_CAMPAIGN_TARGET.sutApplicationId,
      DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS: "1000",
      DISCORD_E2E_CONVERSATION_VOICE_GUILD_ID: HOSTED_CAMPAIGN_TARGET.guildId,
      DISCORD_E2E_CONVERSATION_VOICE_MEETING_ID: reconnectBinding.recordingId,
      DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID: HOSTED_CAMPAIGN_TARGET.observerApplicationId,
      DISCORD_E2E_CONVERSATION_VOICE_OUTPUT: paths.run(3, "capture-1.json"),
      DISCORD_E2E_CONVERSATION_VOICE_PRIVATE_TEST_GUILD: "private-test-guild",
      DISCORD_E2E_CONVERSATION_VOICE_PURPOSE: "greeting",
      DISCORD_E2E_CONVERSATION_VOICE_RECORDING_ID: reconnectBinding.recordingId,
      DISCORD_E2E_CONVERSATION_VOICE_RUN_ID: reconnect.runId,
      DISCORD_E2E_CONVERSATION_VOICE_SECRET_DIRECTORY: definition.secretDirectory,
      DISCORD_E2E_CONVERSATION_VOICE_TURN_ID: `${reconnect.runId}:greeting`,
      DISCORD_E2E_CONVERSATION_VOICE_VOICE_CHANNEL_ID: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
      DISCORD_E2E_HOSTED_CAMPAIGN_ID: definition.campaignId,
    }, produces: reconnectActions.map((item) => produced(reconnect, item.action, barrierPath(`${item.action.kind}-${"ordinal" in item.action ? item.action.ordinal : "event"}`))),
    requires: [runVerified[1]!], startBefore: { ...reconnectActions[0]!, kind: "barrier" },
  };
  const collector = (
    run: HostedCampaignRun & { readonly ordinal: 1 | 2 | 3 },
    action: HostedCampaignActionReference & { readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "run-verified" }> },
    binding: typeof sequentialBinding,
    required: readonly HostedCampaignActionReference[],
  ): HostedCampaignExecutableSpec => {
    const evidencePath = paths.run(run.ordinal, "evidence.json");
    return {
      arguments: { kind: "environment" }, childId: `collector-${run.ordinal}`,
      completion: { action: action.action, evidencePath, kind: "collector", runId: run.runId },
      entrypoint: "collector", environment: {
        ...remote, ...revisions, DISCORD_E2E_ACTOR_RUN_INPUT: paths.run(run.ordinal, "actor.json"),
        DISCORD_E2E_EVIDENCE_OUTPUT: evidencePath, DISCORD_E2E_FIXTURE_MANIFEST: definition.fixtureManifestPath,
        DISCORD_E2E_READY_RECEIPT_INPUT: paths.run(run.ordinal, "recording-ready.json"),
        DISCORD_E2E_RECORDING_ID: binding.recordingId, DISCORD_E2E_RECORDING_PLAYBACK_ORIGIN: definition.recordingPlaybackOrigin,
        DISCORD_E2E_RECORDING_PLAYBACK_READINESS: "already-ready", DISCORD_E2E_RECORDING_PLAYBACK_TEST_SCOPE: "private-test-deployment",
        DISCORD_E2E_REMOTE_ATTESTATION_FILE: binding.remoteAttestationPath, DISCORD_E2E_RUN_ID: run.runId,
        DISCORD_E2E_SECRET_DIRECTORY: definition.secretDirectory,
      }, produces: [produced(run, action.action, barrierPath(`run-${run.ordinal}-verified`))], requires: required,
      startBefore: { ...action, kind: "barrier" },
    };
  };
  const campaignVerifier: HostedCampaignExecutableSpec = {
    arguments: {
      evidencePaths: [paths.run(1, "evidence.json"), paths.run(2, "evidence.json"), paths.run(3, "evidence.json")],
      kind: "campaign-verifier", manifestPath: paths.campaignManifest, thresholdsPath: definition.serviceLevelThresholdsPath,
    }, childId: "campaign-verifier", completion: {
      action: { kind: "campaign-verified" }, campaignId: definition.campaignId, kind: "campaign-verifier", runIds: definition.runIds,
    }, entrypoint: "campaign-verifier", environment: {}, produces: [produced(reconnect, campaignVerified.action, barrierPath("campaign-verified"))],
    requires: [provenanceAfter], startBefore: { ...campaignVerified, kind: "barrier" },
  };
  return Object.freeze([
    provenance("before", sequential, provenanceBefore), liveObserver,
    collector(sequential, runVerified[0]!, sequentialBinding, [provenanceBefore, observerSubscribed]),
    collector(overlap, runVerified[1]!, overlapBinding, [runVerified[0]!]), conversationObserver,
    collector(reconnect, runVerified[2]!, reconnectBinding, reconnectActions),
    provenance("after", reconnect, provenanceAfter), campaignVerifier,
  ]);
}
