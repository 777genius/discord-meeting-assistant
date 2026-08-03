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
    readonly default_member_permissions?: unknown;
    readonly description?: unknown;
    readonly options?: unknown;
  };
  return actual.description === expected.description &&
    actual.default_member_permissions === expected.default_member_permissions &&
    JSON.stringify(actual.options ?? []) === JSON.stringify(expected.options ?? []);
}
