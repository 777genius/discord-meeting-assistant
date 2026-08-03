import type {
  ConfigureGuild,
  ConfigureGuildResult,
} from "@discord-meeting/guild-configuration-core";
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
  .setName("setup")
  .setDescription("Configure voice meetings and the results channel")
  .setDescriptionLocalization("ru", "Настроить голосовые встречи и канал результатов")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addChannelOption((option) =>
    option
      .setName("voice-channel")
      .setNameLocalization("ru", "голосовой-канал")
      .setDescription("Voice channel recorded by Craig")
      .setDescriptionLocalization("ru", "Голосовой канал, который записывает Craig")
      .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
      .setRequired(true)
  )
  .addChannelOption((option) =>
    option
      .setName("results-channel")
      .setNameLocalization("ru", "канал-результатов")
      .setDescription("Text channel for live transcript and summary")
      .setDescriptionLocalization("ru", "Текстовый канал для транскрипта и саммари")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(true)
  );

interface ConfigureGuildUseCase {
  execute(input: Parameters<ConfigureGuild["execute"]>[0]): Promise<ConfigureGuildResult>;
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
    private readonly configureGuild: ConfigureGuildUseCase,
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
    if (!interaction.isChatInputCommand() || interaction.commandName !== "setup") {
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
        content: "Для /setup требуется право Управление сервером.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const voiceChannel = interaction.options.getChannel("voice-channel", true);
    const resultsChannel = interaction.options.getChannel("results-channel", true);
    const result = await this.configureGuild.execute({
      configuredByUserId: interaction.user.id,
      guildId: interaction.guildId,
      resultsChannelId: resultsChannel.id,
      voiceChannelId: voiceChannel.id,
    });
    await interaction.editReply({ content: renderSetupResult(result, this.craigInstallUrl) });
  }

  private async replyWithUnexpectedFailure(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "setup") {
      return;
    }
    const response = "Не удалось завершить настройку. Попробуйте /setup ещё раз.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: response });
      return;
    }
    await interaction.reply({ content: response, flags: MessageFlags.Ephemeral });
  }
}

function renderSetupResult(result: ConfigureGuildResult, craigInstallUrl: string): string {
  if (result.status === "configured") {
    return "✅ Готово. Права проверены, тестовое сообщение опубликовано, настройки сохранены.";
  }
  if (result.status === "reused") {
    return "✅ Этот сервер уже настроен. Каналы и маршрутизация не изменились.";
  }
  if (result.status === "conflict") {
    return "Настройки одновременно изменил другой администратор. Запустите /setup ещё раз.";
  }
  if ("failure" in result && result.failure.code === "craig-not-installed") {
    return `${result.failure.message}\nУстановить Craig: ${craigInstallUrl}`;
  }
  return "failure" in result ? result.failure.message : "Настройка не завершена.";
}
