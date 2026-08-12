import { isAbsolute, normalize } from "node:path";

import { z } from "zod";

import {
  HOSTED_CAMPAIGN_TARGET,
  type HostedCampaignInput,
  type HostedCampaignRun,
  validateHostedCampaign,
} from "./hosted-campaign-coordinator.js";
import { makeHostedCampaignChildren } from "./hosted-campaign-plan-children.js";

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
  clockPreflightPath: absolutePath,
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
  speakerFixtures: z.object({ a: absolutePath, b: absolutePath }).strict(),
  serviceLevelThresholdsPath: absolutePath,
  supplementalManifestPath: absolutePath,
}).strict().superRefine((value, context) => {
  if (new Set(value.runIds).size !== 3) {
    context.addIssue({ code: "custom", message: "Hosted campaign definition runIds must be unique", path: ["runIds"] });
  }
});

export type HostedCampaignDefinitionV1 = z.infer<typeof hostedCampaignDefinitionV1Schema>;

const bindingSchema = z.object({
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
  key: `runs.${0 | 1 | 2}.remoteAttestationPath`;
  source: "operator-selected-create-only-attestation-path";
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
  { key: "runs.0.remoteAttestationPath", source: "operator-selected-create-only-attestation-path" },
  { key: "runs.1.remoteAttestationPath", source: "operator-selected-create-only-attestation-path" },
  { key: "runs.2.remoteAttestationPath", source: "operator-selected-create-only-attestation-path" },
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
  const runs = makeRuns(definition);
  const children = makeHostedCampaignChildren(definition, bindings, runs, definition.campaignRoot);
  const plan = Object.freeze({
    children: Object.freeze(children),
    runs,
    target: HOSTED_CAMPAIGN_TARGET,
    thresholds: Object.freeze({ answerFirstPacketMilliseconds: definition.answerFirstPacketMilliseconds }),
  });
  validateHostedCampaign(plan);
  return plan;
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
