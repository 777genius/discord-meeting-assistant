import type {
  ConfigureMeetingSource,
  ConfigureMeetingSourceResult,
} from "@discord-meeting/meeting-routing-core";
import {
  ApplicationIntegrationType,
  ChannelType,
  Client,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
} from "discord.js";

export const discordGuildSetupCommand = new SlashCommandBuilder()
  .setName("setup-voice-bot")
  .setDescription("Configure voice meeting recording and the results channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addChannelOption((option) =>
    option
      .setName("voice-channel")
      .setDescription("Voice channel recorded by Craig")
      .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
      .setRequired(true)
  )
  .addChannelOption((option) =>
    option
      .setName("results-channel")
      .setDescription("Text channel for live transcript and summary")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(true)
  );

interface ConfigureMeetingSourceUseCase {
  execute(
    input: Parameters<ConfigureMeetingSource["execute"]>[0],
  ): Promise<ConfigureMeetingSourceResult>;
}

export class DiscordGuildSetupCommandHandler {
  private readonly listener = (interaction: Interaction): void => {
    void this.handle(interaction)
      .catch(async (error: unknown) => {
        this.onError(error);
        await this.replyWithUnexpectedFailure(interaction);
      })
      .catch((error: unknown) => {
        this.onError(error);
      });
  };

  public constructor(
    private readonly client: Client,
    private readonly configureMeetingSource: ConfigureMeetingSourceUseCase,
    private readonly craigInstallUrl: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  public start(): void {
    this.client.on("interactionCreate", this.listener);
  }

  public close(): void {
    this.client.off("interactionCreate", this.listener);
  }

  public async handle(interaction: Interaction): Promise<boolean> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "setup-voice-bot") {
      return false;
    }
    await this.handleSetup(interaction);
    return true;
  }

  private async handleSetup(interaction: ChatInputCommandInteraction): Promise<void> {
    if (
      interaction.guildId === null ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) !== true
    ) {
      await interaction.reply({
        content: "You need the Manage Server permission to use /setup-voice-bot.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const voiceChannel = interaction.options.getChannel("voice-channel", true);
    const resultsChannel = interaction.options.getChannel("results-channel", true);
    const result = await this.configureMeetingSource.execute({
      configuredByActorId: interaction.user.id,
      publicationTargetId: resultsChannel.id,
      roomId: voiceChannel.id,
      sourceId: interaction.guildId,
    });
    await interaction.editReply({ content: renderSetupResult(result, this.craigInstallUrl) });
  }

  private async replyWithUnexpectedFailure(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "setup-voice-bot") {
      return;
    }
    const response = "Setup could not be completed. Please run /setup-voice-bot again.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: response });
      return;
    }
    await interaction.reply({ content: response, flags: MessageFlags.Ephemeral });
  }
}

function renderSetupResult(
  result: ConfigureMeetingSourceResult,
  craigInstallUrl: string,
): string {
  if (result.status === "configured") {
    return "✅ Setup complete. Permissions were verified, a test message was posted, and settings were saved. Recording starts automatically when people join the selected voice channel.";
  }
  if (result.status === "reused") {
    return "✅ This server is already configured. Channels and routing were unchanged. Recording starts automatically when people join the selected voice channel.";
  }
  if (result.status === "conflict") {
    return "Another administrator changed the settings at the same time. Run /setup-voice-bot again.";
  }
  if (
    "failure" in result &&
    result.failure.code === "capture-capability-unavailable"
  ) {
    return `${result.failure.message}\nInstall Craig: ${craigInstallUrl}`;
  }
  return "failure" in result ? result.failure.message : "Setup was not completed.";
}
