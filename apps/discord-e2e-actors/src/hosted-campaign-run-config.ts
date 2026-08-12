import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  HOSTED_CAMPAIGN_TARGET,
  type HostedCampaignExecutableSpec,
  type HostedCampaignInput,
} from "./hosted-campaign-coordinator.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const environment = z.record(z.string(), z.string());
const executableSchema = z.object({
  arguments: z.array(z.string()),
  childId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  entrypoint: z.enum([
    "actor", "campaign-verifier", "collector", "conversation-observer", "evidence-verifier",
    "live-observer", "supplemental-player",
  ]),
  environment,
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
