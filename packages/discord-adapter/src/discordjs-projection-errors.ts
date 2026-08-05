export class DiscordProjectionConflictError extends Error {
  public constructor(entity: "projection" | "thread" | "message", marker: string) {
    super(`Multiple Discord projection ${entity}s exist for marker ${marker}`);
    this.name = "DiscordProjectionConflictError";
  }
}

export class DiscordProjectionConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DiscordProjectionConfigurationError";
  }
}
