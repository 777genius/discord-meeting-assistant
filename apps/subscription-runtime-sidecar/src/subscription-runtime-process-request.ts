import {
  subscriptionRuntimeProvider,
  subscriptionRuntimeReasoningEffort,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeExecutionProfile,
} from "@discord-meeting/subscription-runtime-adapter";

const allowedChildEnvironmentKeys = new Set([
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
  "TZ",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);

export interface SubscriptionRuntimeCliOptions {
  readonly authJsonPath: string;
  readonly providerInstanceId: string;
  readonly stateRoot: string;
}

export function buildChildEnvironment(
  source: NodeJS.ProcessEnv,
  localEncryptionKey: string,
  reasoningEffort: SubscriptionRuntimeExecutionProfile["reasoningEffort"] = subscriptionRuntimeReasoningEffort,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const upperKey = key.toUpperCase();
    if (
      value === undefined ||
      upperKey.endsWith("_API_KEY") ||
      upperKey.endsWith("_API_KEY_FILE") ||
      (!allowedChildEnvironmentKeys.has(key) && !key.startsWith("LC_"))
    ) {
      continue;
    }
    env[key] = value;
  }
  env.AGENT_RUNTIME_REASONING_EFFORT = reasoningEffort;
  env.SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY = localEncryptionKey;
  return env;
}

export function buildCliArgs(
  request: SubscriptionRuntimeAgentTaskRequest,
  inputPath: string,
  options: SubscriptionRuntimeCliOptions,
  profile: SubscriptionRuntimeExecutionProfile,
): readonly string[] {
  return [
    "--provider",
    subscriptionRuntimeProvider,
    "--input",
    inputPath,
    "--format",
    "result-json",
    "--timeout-ms",
    String(request.timeoutMs),
    "--state-root",
    options.stateRoot,
    "--codex-auth-json",
    options.authJsonPath,
    "--provider-instance",
    options.providerInstanceId,
    "--model",
    profile.model,
  ];
}
