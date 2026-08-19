import type {
  MeetingSourceConfigurationVerificationPort,
  MeetingSourceConfigurationVerificationRequest,
  MeetingSourceSetupFailure,
  MeetingSourceSetupPublicationRequest,
  MeetingSourceSetupPublisher,
} from "@discord-meeting/meeting-routing-core";
import {
  ChannelType,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
  type TextChannel,
} from "discord.js";

const requiredResultsPermissions = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
] as const;
const requiredCraigVoicePermissions = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
] as const;

function failure(
  code: MeetingSourceSetupFailure["code"],
  message: string,
  retryable = false,
): { readonly failure: MeetingSourceSetupFailure; readonly ok: false } {
  return { failure: { code, message, retryable }, ok: false };
}

function isUnknownMember(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === 10_007;
}

function hasAllPermissions(
  channel: GuildBasedChannel,
  subjectId: string,
  required: readonly bigint[],
): boolean {
  const permissions = channel.permissionsFor(subjectId);
  return permissions !== null && required.every((permission) => permissions.has(permission));
}

function isResultsChannel(channel: GuildBasedChannel): channel is TextChannel {
  return channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
}

function isVoiceChannel(channel: GuildBasedChannel): boolean {
  return channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
}

export class DiscordGuildSetupAdapter implements
  MeetingSourceConfigurationVerificationPort,
  MeetingSourceSetupPublisher
{
  public constructor(
    private readonly client: Client,
    private readonly craigBotUserId: string,
  ) {}

  public async verify(request: MeetingSourceConfigurationVerificationRequest) {
    const guildId = requireDiscordSnowflake(request.sourceId, "sourceId");
    const actorId = requireDiscordSnowflake(
      request.configuredByActorId,
      "configuredByActorId",
    );
    const voiceChannelId = requireDiscordSnowflake(request.roomId, "roomId");
    const resultsChannelId = requireDiscordSnowflake(
      request.publicationTargetId,
      "publicationTargetId",
    );
    const guild = await this.fetchGuild(guildId);
    const actor = await guild.members.fetch(actorId).catch(() => null);
    if (actor === null || !actor.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return failure(
        "actor-not-authorized",
        "You need the Manage Server permission to configure this server.",
      );
    }
    const [voiceChannel, resultsChannel] = await Promise.all([
      guild.channels.fetch(voiceChannelId),
      guild.channels.fetch(resultsChannelId),
    ]);
    if (voiceChannel === null || !isVoiceChannel(voiceChannel)) {
      return failure("capture-room-invalid", "Select a voice or Stage channel.");
    }
    if (resultsChannel === null || !isResultsChannel(resultsChannel)) {
      return failure(
        "publication-target-invalid",
        "Select a text or announcement channel.",
      );
    }
    const platformUserId = this.client.user?.id;
    if (
      platformUserId === undefined ||
      !hasAllPermissions(resultsChannel, platformUserId, requiredResultsPermissions)
    ) {
      return failure(
        "publication-target-permission-missing",
        "Meeting Assistant cannot view the results channel, send messages, or embed links.",
      );
    }
    const craig = await guild.members.fetch(this.craigBotUserId).catch((error: unknown) => {
      if (isUnknownMember(error)) {
        return null;
      }
      throw error;
    });
    if (craig === null) {
      return failure(
        "capture-capability-unavailable",
        "Install the separate Craig Voice Gateway first.",
      );
    }
    if (!hasAllPermissions(voiceChannel, craig.id, requiredCraigVoicePermissions)) {
      return failure(
        "capture-room-permission-missing",
        "Craig Voice Gateway needs the View Channel and Connect permissions.",
      );
    }
    return { ok: true as const };
  }

  public async publish(request: MeetingSourceSetupPublicationRequest) {
    try {
      const guildId = requireDiscordSnowflake(request.sourceId, "sourceId");
      const voiceChannelId = requireDiscordSnowflake(request.roomId, "roomId");
      const resultsChannelId = requireDiscordSnowflake(
        request.publicationTargetId,
        "publicationTargetId",
      );
      const actorId = requireDiscordSnowflake(
        request.configuredByActorId,
        "configuredByActorId",
      );
      const guild = await this.fetchGuild(guildId);
      const channel = await guild.channels.fetch(resultsChannelId);
      if (channel === null || !isResultsChannel(channel)) {
        return failure(
          "publication-target-invalid",
          "The results channel is no longer available.",
        );
      }
      const footer = `Server setup · revision ${request.configurationRevision + 1}`;
      const embed = new EmbedBuilder()
        .setColor(0x57_f2_87)
        .setTitle("Meeting Assistant channel check")
        .setDescription(
          "✅ The bot can publish transcripts and summaries here.\n" +
          `Voice channel: <#${voiceChannelId}>\n` +
          `Checked by: <@${actorId}>`,
        )
        .setFooter({ text: footer });
      const nonce = createHash("sha256")
        .update(request.idempotencyKey)
        .digest("hex")
        .slice(0, 25);
      await channel.send({ embeds: [embed], enforceNonce: true, nonce });
      return { ok: true as const };
    } catch {
      return failure(
        "setup-publication-failed",
        "Could not post the test message. Check channel permissions and try again.",
        true,
      );
    }
  }

  private async fetchGuild(guildId: string): Promise<Guild> {
    return this.client.guilds.fetch(guildId);
  }
}

const discordSnowflake = /^\d{17,20}$/u;

function requireDiscordSnowflake(value: string, field: string): string {
  if (!discordSnowflake.test(value)) {
    throw new TypeError(`${field} must be a Discord snowflake`);
  }
  return value;
}
import { createHash } from "node:crypto";
