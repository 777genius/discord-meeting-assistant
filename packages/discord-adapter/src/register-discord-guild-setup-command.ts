import {
  Client,
  type ApplicationCommand,
} from "discord.js";

import { discordGuildSetupCommand } from "./discord-guild-setup-command.js";

export async function registerDiscordGuildSetupCommand(client: Client): Promise<void> {
  if (!client.isReady()) {
    throw new Error("Discord client must be ready before command registration");
  }
  const commands = await client.application.commands.fetch();
  const current = commands.find((command) => command.name === discordGuildSetupCommand.name);
  const definition = discordGuildSetupCommand.toJSON();
  if (current === undefined) {
    await client.application.commands.create(definition);
    return;
  }
  if (!sameCommandDefinition(current, definition)) {
    await client.application.commands.edit(current.id, definition);
  }
}

function sameCommandDefinition(
  current: ApplicationCommand,
  expected: ReturnType<typeof discordGuildSetupCommand.toJSON>,
): boolean {
  const actual = current.toJSON() as {
    readonly contexts?: unknown;
    readonly default_member_permissions?: unknown;
    readonly description?: unknown;
    readonly description_localizations?: unknown;
    readonly integration_types?: unknown;
    readonly name_localizations?: unknown;
    readonly options?: unknown;
  };
  return actual.description === expected.description &&
    actual.default_member_permissions === expected.default_member_permissions &&
    sameJson(actual.contexts, expected.contexts) &&
    sameJson(actual.integration_types, expected.integration_types) &&
    sameJson(actual.name_localizations, expected.name_localizations) &&
    sameJson(actual.description_localizations, expected.description_localizations) &&
    JSON.stringify(actual.options ?? []) === JSON.stringify(expected.options ?? []);
}

function sameJson(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null);
}
