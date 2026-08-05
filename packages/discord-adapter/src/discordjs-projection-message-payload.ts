import type { DiscordProjectionBody } from "./discord-projection.js";
import { discordProjectionBodySchema } from "./discord-projection.js";
import { createProjectionMarkerUrl } from "./projection-marker.js";

export const projectionFooter = "Meeting Platform · meeting summary";
export const legacyProjectionFooter = "Meeting Platform · итог встречи";

export function toDiscordMessagePayload(rawBody: DiscordProjectionBody, marker?: string) {
  const body = discordProjectionBodySchema.parse(rawBody);
  return {
    allowedMentions: { parse: [] as const, repliedUser: false },
    embeds: [
      {
        description: body.markdown,
        footer: { text: projectionFooter },
        ...(marker === undefined ? {} : { url: createProjectionMarkerUrl(marker) }),
      },
      ...(body.liveCaptionsMarkdown === undefined
        ? []
        : [{ description: body.liveCaptionsMarkdown }]),
    ],
    // discord.js sends only the supplied file IDs on edit, replacing an older
    // transcript attachment rather than accumulating retry duplicates.
    ...(body.transcriptAttachment === undefined
      ? {}
      : {
        files: [{
          attachment: Buffer.from(body.transcriptAttachment.content, "utf8"),
          name: body.transcriptAttachment.filename,
        }],
      }),
  };
}

export function toDiscordRestMessageEditBody(rawBody: DiscordProjectionBody, marker: string) {
  const body = discordProjectionBodySchema.parse(rawBody);
  return {
    allowed_mentions: { parse: [] as const, replied_user: false },
    embeds: [
      {
        description: body.markdown,
        footer: { text: projectionFooter },
        url: createProjectionMarkerUrl(marker),
      },
      ...(body.liveCaptionsMarkdown === undefined
        ? []
        : [{ description: body.liveCaptionsMarkdown }]),
    ],
  };
}
