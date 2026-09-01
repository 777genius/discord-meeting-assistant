const forbiddenTokenEnvironmentNames = /^(?:DISCORD_TOKEN|DISCORD_BOT_TOKEN|DISCORD_E2E_[A-Z0-9_]*TOKEN)$/u;
const discordTokenShape = /[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{6,}\.[A-Za-z\d_-]{20,}/gu;
const bearerShape = /\bBearer\s+\S+/giu;

export function rejectTokenEnvironment(environment: NodeJS.ProcessEnv): void {
  const supplied = Object.keys(environment).filter((name) =>
    forbiddenTokenEnvironmentNames.test(name) && (environment[name]?.length ?? 0) > 0);
  if (supplied.length > 0) {
    throw new Error("TOKEN_ENV_FORBIDDEN: Discord credentials must come from the private secret reader");
  }
}

export function sanitizedCliError(error: unknown, environment: NodeJS.ProcessEnv): string {
  let message = error instanceof Error ? error.message : "Unknown command failure";
  for (const [name, value] of Object.entries(environment)) {
    if (/(?:TOKEN|SECRET|PASSWORD|KEY)$/u.test(name) && value !== undefined && value.length >= 4) {
      message = message.replaceAll(value, "[redacted]");
    }
  }
  return message
    .replace(discordTokenShape, "[redacted-token]")
    .replace(bearerShape, "Bearer [redacted]")
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 512);
}
