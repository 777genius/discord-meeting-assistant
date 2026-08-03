export const runtimePackageName = "@vioxen/subscription-runtime" as const;
export const runtimePackageVersion = "0.1.0-main.2" as const;
export const providerInstanceId = "discord-meeting-summary-v3" as const;
export const applicationName = "discord-meeting" as const;
export const tenantId = "discord-meeting" as const;
export const healthServiceName = "discord-meeting-summary" as const;

export const grpcProviderCodex = "AGENT_RUNTIME_PROVIDER_CODEX" as const;
export const grpcTaskCompleted =
  "AGENT_RUNTIME_TASK_STATUS_COMPLETED" as const;
export const grpcTaskFailed = "AGENT_RUNTIME_TASK_STATUS_FAILED" as const;
export const grpcTaskWaiting =
  "AGENT_RUNTIME_TASK_STATUS_WAITING_FOR_INPUT" as const;
export const grpcOutputStructured =
  "AGENT_RUNTIME_SELECTED_OUTPUT_KIND_STRUCTURED_OUTPUT" as const;
export const grpcHealthServing =
  "AGENT_RUNTIME_HEALTH_STATUS_SERVING" as const;
export const grpcHealthDegraded =
  "AGENT_RUNTIME_HEALTH_STATUS_DEGRADED" as const;
export const grpcHealthNotServing =
  "AGENT_RUNTIME_HEALTH_STATUS_NOT_SERVING" as const;
export const grpcTokenMeasured =
  "AGENT_RUNTIME_TOKEN_AVAILABILITY_MEASURED" as const;
export const grpcTokenDerived =
  "AGENT_RUNTIME_TOKEN_AVAILABILITY_DERIVED" as const;
export const grpcTokenUnavailable =
  "AGENT_RUNTIME_TOKEN_AVAILABILITY_UNAVAILABLE" as const;
export const grpcDerivedTokenInput =
  "AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_INPUT" as const;
export const grpcDerivedTokenOutput =
  "AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_OUTPUT" as const;
