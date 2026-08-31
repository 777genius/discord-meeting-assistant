import type { AnswerPublicationBinding } from "@discord-meeting/meeting-core/publishing";
import { ChannelType } from "discord.js";

export const botId = "11111111111111111";
export const containerId = "22222222222222222";
export const questionId = "33333333333333333";
export const guildId = "66666666666666666";

export function ingressMessage(overrides: Readonly<Record<string, unknown>> = {}) {
  return { author: { bot: false, id: "77777777777777777" },
    channel: { isThread: () => false }, channelId: containerId,
    content: "What changed?", guildId, id: questionId,
    reference: { channelId: containerId, messageId: "44444444444444444" },
    webhookId: null, ...overrides };
}

export function deletedMessage(overrides: Readonly<Record<string, unknown>> = {}) {
  return { channel: { isThread: () => false }, channelId: containerId,
    guildId, id: "44444444444444444", ...overrides };
}

export function directDeliveryChannelMetadata() {
  return { guild_id: guildId, id: containerId, name: "meeting-results",
    parent_id: "77777777777777770", permission_overwrites: [], type: ChannelType.GuildText };
}

export function authoredAnswerMessage(input: { readonly embeds: readonly unknown[];
  readonly id: string; readonly overrides?: Readonly<Record<string, unknown>> }) {
  return { application_id: botId, attachments: [], author: { id: botId },
    channel_id: containerId, components: [], content: "", embeds: input.embeds,
    guild_id: guildId, id: input.id, mention_everyone: false, mention_roles: [], mentions: [],
    message_reference: { channel_id: containerId, message_id: questionId, type: 0 },
    pinned: false, sticker_items: [], tts: false, type: 19, ...input.overrides };
}

export function binding(): AnswerPublicationBinding {
  return { authorizationDigest: "a".repeat(64),
    authorizationPolicyVersion: "discord.participant-current-results.v1",
    authorizationPrincipalRef: "opaque", botApplicationIdentity: botId,
    canonicalEvidenceHash: "b".repeat(64), deliveryContainerId: containerId,
    expectedLocale: "en", finalProjectionEpoch: "epoch-1",
    finalProjectionReceipt: `discord:v2:channel:${containerId}:message:44444444444444444`,
    humanActorIds: ["77777777777777777"], meetingId: "meeting-1", meetingRevision: 4,
    memoryGeneration: `focused-memory:v1:${"b".repeat(64)}`,
    policyVersion: "discord.participant-current-results.v1",
    projectionTargetContainerId: containerId, questionHash: "c".repeat(64), questionId,
    requesterSubject: "d".repeat(64), roomId: "55555555555555555", scopeId: guildId,
    transcriptId: "transcript-1", transcriptVersion: 1 };
}
