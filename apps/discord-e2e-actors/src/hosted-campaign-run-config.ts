import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  HOSTED_CAMPAIGN_TARGET,
  type HostedCampaignExecutableSpec,
  type HostedCampaignInput,
} from "./hosted-campaign-coordinator.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const environment = z.record(z.string(), z.string());
const argumentsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("environment") }).strict(),
  z.object({
    evidencePath: z.string().refine(isAbsolute), kind: z.literal("evidence-verifier"),
    manifestPath: z.string().refine(isAbsolute), thresholdsPath: z.string().refine(isAbsolute).optional(),
  }).strict(),
  z.object({
    evidencePaths: z.tuple([z.string().refine(isAbsolute), z.string().refine(isAbsolute), z.string().refine(isAbsolute)]),
    kind: z.literal("campaign-verifier"), manifestPath: z.string().refine(isAbsolute),
    thresholdsPath: z.string().refine(isAbsolute).optional(),
  }).strict(),
]);
const barrierActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("provenance-before") }).strict(),
  z.object({ kind: z.literal("observer-subscribed") }).strict(),
  z.object({ kind: z.literal("capture-retained"), ordinal: z.number().int().safe().positive() }).strict(),
  z.object({ kind: z.literal("reconnect-left") }).strict(),
  z.object({ kind: z.literal("reconnect-ready") }).strict(),
  z.object({ kind: z.literal("answer-intent") }).strict(),
  z.object({ kind: z.literal("answer-observer-ready") }).strict(),
  z.object({ kind: z.literal("answer-first-packet") }).strict(),
  z.object({ kind: z.literal("run-verified"), ordinal: z.number().int().safe().positive(), runId: identifier }).strict(),
  z.object({ kind: z.literal("provenance-after") }).strict(),
  z.object({ kind: z.literal("campaign-verified") }).strict(),
]);
const runVerifiedActionSchema = z.object({
  kind: z.literal("run-verified"), ordinal: z.number().int().min(1).max(3), runId: identifier,
}).strict();
const completionSchema = z.discriminatedUnion("kind", [
  z.object({
    action: runVerifiedActionSchema, evidencePath: z.string().refine(isAbsolute),
    kind: z.literal("collector"), runId: identifier,
  }).strict(),
  z.object({ action: runVerifiedActionSchema, kind: z.literal("evidence-verifier") }).strict(),
  z.object({
    action: z.object({ kind: z.literal("campaign-verified") }).strict(), campaignId: identifier,
    kind: z.literal("campaign-verifier"), runIds: z.tuple([identifier, identifier, identifier]),
  }).strict(),
]);
const executableSchema = z.object({
  arguments: argumentsSchema,
  childId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  completion: completionSchema.optional(),
  entrypoint: z.enum([
    "actor", "campaign-verifier", "collector", "conversation-observer", "evidence-verifier",
    "live-observer", "recording-ready", "supplemental-player",
  ]),
  environment,
  releaseGate: z.object({
    action: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("provenance-before") }).strict(),
      z.object({ kind: z.literal("observer-subscribed") }).strict(),
    ]),
    path: z.string().refine(isAbsolute),
  }).strict().optional(),
  startBefore: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("campaign") }).strict(),
    z.object({ action: barrierActionSchema, kind: z.literal("barrier") }).strict(),
  ]),
}).strict();

const targetSchema = z.object(
  Object.fromEntries(Object.entries(HOSTED_CAMPAIGN_TARGET).map(([key, value]) => [key, z.literal(value)])),
).strict();

const planSchema = z.object({
  children: z.array(executableSchema).min(1),
  runs: z.tuple([
    runSchema(1, "sequential", 0),
    runSchema(2, "overlap", 0),
    runSchema(3, "reconnect", 6),
  ]),
  target: targetSchema,
  thresholds: z.object({
    answerFirstPacketMilliseconds: z.number().int().positive(),
  }).strict(),
}).strict();

export interface HostedCampaignRunConfig {
  readonly deadlineEpochMilliseconds: number;
  readonly input: HostedCampaignInput;
  readonly receiptPath: string;
}

function runSchema(ordinal: number, scenario: "overlap" | "reconnect" | "sequential", captures: number) {
  return z.object({
    campaignId: identifier,
    ordinal: z.literal(ordinal),
    retainedCaptureCount: z.literal(captures),
    runId: identifier,
    scenario: z.literal(scenario),
  }).strict();
}

export function parseHostedCampaignPlan(value: unknown): HostedCampaignInput {
  const parsed = planSchema.parse(value);
  const [first, second, third] = parsed.runs;
  if (first.campaignId !== second.campaignId || first.campaignId !== third.campaignId) {
    throw new Error("Hosted campaign runs must share one campaignId");
  }
  if (new Set(parsed.runs.map(({ runId }) => runId)).size !== 3) {
    throw new Error("Hosted campaign runIds must be unique");
  }
  return parsed as unknown as HostedCampaignInput;
}

export function parseHostedCampaignArguments(arguments_: readonly string[]): {
  readonly planPath: string;
  readonly receiptPath: string;
  readonly timeoutMilliseconds: number;
} {
  if (arguments_.length !== 3) {
    throw new Error("Usage: run-hosted-campaign <plan.json> <receipt.json> <timeout-ms>");
  }
  const [planPath, receiptPath, timeoutText] = arguments_ as [string, string, string];
  if (!isAbsolute(planPath) || !isAbsolute(receiptPath)) {
    throw new Error("Hosted campaign plan and receipt paths must be absolute");
  }
  const timeoutMilliseconds = Number(timeoutText);
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 86_400_000) {
    throw new Error("Hosted campaign timeout must be an integer from 1 to 86400000ms");
  }
  return { planPath, receiptPath, timeoutMilliseconds };
}

export function assertExecutableEnvironmentPaths(children: readonly HostedCampaignExecutableSpec[]): void {
  for (const child of children) {
    for (const [name, value] of Object.entries(child.environment)) {
      if ((name.endsWith("_INPUT") || name.endsWith("_OUTPUT") || name.endsWith("_ROOT")) && !isAbsolute(value)) {
        throw new Error(`Executable ${child.childId} environment ${name} must be an absolute path`);
      }
    }
  }
}
