import { PermissionFlagsBits, PermissionsBitField } from "discord.js";

const snowflake = /^\d{17,20}$/u;

export const meetingPlatformInstallPermissions = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
]).bitfield;

export const craigGatewayInstallPermissions = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
]).bitfield;

export function createDiscordGuildInstallUrl(input: {
  readonly applicationId: string;
  readonly permissions: bigint;
}): string {
  if (!snowflake.test(input.applicationId)) {
    throw new Error("applicationId must be a Discord snowflake");
  }
  if (input.permissions < 0n) {
    throw new Error("permissions cannot be negative");
  }
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", input.applicationId);
  url.searchParams.set("integration_type", "0");
  url.searchParams.set("permissions", input.permissions.toString());
  url.searchParams.set("scope", "bot applications.commands");
  return url.toString();
}
