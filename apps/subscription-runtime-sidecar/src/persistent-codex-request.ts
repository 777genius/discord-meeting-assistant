import { pathToFileURL } from "node:url";

import type {
  JsonObject,
  SubscriptionRuntimeExecutionProfile,
} from "@discord-meeting/subscription-runtime-adapter";

import type {
  LauncherPolicyModule,
  PersistentCodexProfile,
} from "./persistent-codex-process-contracts.js";

export interface PersistentCodexCanonicalRequest {
  readonly context: { readonly purpose: string };
  readonly runId: string;
  readonly task: {
    readonly controls: JsonObject & {
      readonly maxOutputTokens: number;
      readonly model: string;
      readonly outputSchema: JsonObject;
      readonly outputSchemaName: string;
      readonly reasoningEffort: string;
      readonly serviceTier?: string;
    };
    readonly metadata: Readonly<Record<string, string>> & {
      readonly policyVersion: string;
      readonly serviceTier?: string;
    };
    readonly outputSchemaName: string;
    readonly prompt: string;
    readonly systemPrompt: string;
  };
}

export function parsePersistentCodexRequest(value: unknown): PersistentCodexCanonicalRequest {
  if (!isRecord(value) || !isRecord(value.context) || !isRecord(value.task)) {
    throw new Error("Persistent runtime request is malformed");
  }
  const controls = value.task.controls;
  const metadata = value.task.metadata;
  if (
    !isRecord(controls) ||
    !isRecord(controls.outputSchema) ||
    !isString(value.context.purpose) ||
    !isString(value.runId) ||
    !isRecord(metadata) ||
    !isString(metadata.policyVersion) ||
    !isString(value.task.outputSchemaName) ||
    !isString(value.task.prompt) ||
    !isString(value.task.systemPrompt) ||
    !isString(controls.model) ||
    !isString(controls.outputSchemaName) ||
    !isString(controls.reasoningEffort) ||
    !Number.isSafeInteger(controls.maxOutputTokens)
  ) {
    throw new Error("Persistent runtime request conflicts with its admitted profile");
  }
  return value as unknown as PersistentCodexCanonicalRequest;
}

export function profileForPersistentCodexRequest(
  request: PersistentCodexCanonicalRequest,
): PersistentCodexProfile {
  return {
    execution: {
      maxOutputTokens: request.task.controls.maxOutputTokens as SubscriptionRuntimeExecutionProfile["maxOutputTokens"],
      model: request.task.controls.model as SubscriptionRuntimeExecutionProfile["model"],
      outputSchemaName: request.task.controls.outputSchemaName as SubscriptionRuntimeExecutionProfile["outputSchemaName"],
      policyVersion: request.task.metadata.policyVersion as SubscriptionRuntimeExecutionProfile["policyVersion"],
      purpose: request.context.purpose as SubscriptionRuntimeExecutionProfile["purpose"],
      reasoningEffort: request.task.controls.reasoningEffort as SubscriptionRuntimeExecutionProfile["reasoningEffort"],
      ...(request.task.controls.serviceTier === undefined
        ? {}
        : { serviceTier: request.task.controls.serviceTier as "default" }),
    },
    outputSchema: request.task.controls.outputSchema,
  };
}

export function assertSamePersistentCodexProfile(
  left: PersistentCodexProfile,
  right: PersistentCodexProfile,
): void {
  if (
    JSON.stringify(left.execution) !== JSON.stringify(right.execution) ||
    JSON.stringify(left.outputSchema) !== JSON.stringify(right.outputSchema)
  ) {
    throw new Error("Persistent worker profile changed after prewarm");
  }
}

export function structuredPersistentCodexOutputSystemPrompt(
  systemPrompt: string,
  profile: PersistentCodexProfile,
): string {
  return [
    systemPrompt,
    "",
    "Output contract:",
    "Return only one JSON value with no markdown or commentary.",
    `It must match JSON Schema ${profile.execution.outputSchemaName}:`,
    JSON.stringify(profile.outputSchema),
  ].join("\n");
}

export function persistentCodexArgumentValue(
  args: readonly string[],
  flag: string,
): string {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} is required by persistent runner policy`);
  }
  return value;
}

export function optionalPersistentCodexArgumentValue(
  args: readonly string[],
  flag: string,
): string | undefined {
  const indexes = args.flatMap((value, index) => value === flag ? [index] : []);
  if (indexes.length === 0) {
    return undefined;
  }
  if (indexes.length !== 1) {
    throw new Error(`${flag} must occur exactly once in persistent runner policy`);
  }
  const index = indexes[0];
  if (index === undefined) {
    throw new Error(`${flag} is missing from persistent runner policy`);
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value in persistent runner policy`);
  }
  return value;
}

export function requiredPersistentCodexEnvironment(
  environment: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required by persistent runner policy`);
  }
  return value;
}

export async function loadPersistentCodexLauncherPolicy(
  path: string,
): Promise<LauncherPolicyModule> {
  return await import(pathToFileURL(path).href) as LauncherPolicyModule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
