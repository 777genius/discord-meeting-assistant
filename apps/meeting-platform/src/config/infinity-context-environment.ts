interface InfinityContextEnvironmentParts {
  readonly INFINITY_CONTEXT_ACTIVATION?: unknown;
  readonly INFINITY_CONTEXT_OPERATION_TIMEOUT_MS: number;
  readonly INFINITY_CONTEXT_REQUEST_TIMEOUT_MS: number;
  readonly INFINITY_CONTEXT_TOKEN_FILE?: unknown;
  readonly INFINITY_CONTEXT_TOPOLOGY_KEY_FILE?: unknown;
  readonly INFINITY_CONTEXT_URL?: unknown;
}

interface RefinementContext {
  addIssue(issue: {
    readonly code: "custom";
    readonly message: string;
    readonly path: string[];
  }): void;
}

export function validateInfinityContextEnvironment(
  environment: InfinityContextEnvironmentParts,
  context: RefinementContext,
): void {
  const configuredParts = [
    environment.INFINITY_CONTEXT_ACTIVATION,
    environment.INFINITY_CONTEXT_TOKEN_FILE,
    environment.INFINITY_CONTEXT_TOPOLOGY_KEY_FILE,
    environment.INFINITY_CONTEXT_URL,
  ].filter((value) => value !== undefined).length;
  if (configuredParts !== 0 && configuredParts !== 4) {
    context.addIssue({
      code: "custom",
      message: "Infinity activation, endpoint, token file and topology-key file must be configured together",
      path: ["INFINITY_CONTEXT_ACTIVATION"],
    });
  }
  if (
    environment.INFINITY_CONTEXT_OPERATION_TIMEOUT_MS <
      environment.INFINITY_CONTEXT_REQUEST_TIMEOUT_MS
  ) {
    context.addIssue({
      code: "custom",
      message: "Infinity operation timeout must cover at least one SDK request timeout",
      path: ["INFINITY_CONTEXT_OPERATION_TIMEOUT_MS"],
    });
  }
}
