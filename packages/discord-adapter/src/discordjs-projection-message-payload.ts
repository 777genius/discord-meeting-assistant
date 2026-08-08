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
    // Explicitly clear old attachment IDs before uploading this deterministic
    // set, so retries replace both files instead of accumulating duplicates.
    ...(body.summaryAttachment === undefined && body.transcriptAttachment === undefined
      ? {}
      : {
        attachments: [],
        files: [
          ...(body.summaryAttachment === undefined
            ? []
            : [{
              attachment: Buffer.from(body.summaryAttachment.content, "utf8"),
              name: body.summaryAttachment.filename,
            }]),
          ...(body.transcriptAttachment === undefined
            ? []
            : [{
              attachment: Buffer.from(body.transcriptAttachment.content, "utf8"),
              name: body.transcriptAttachment.filename,
            }]),
        ],
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
