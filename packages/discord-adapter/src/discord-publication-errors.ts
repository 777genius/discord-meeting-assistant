import type { StageFailure } from "@discord-meeting/meeting-core";
import { ZodError } from "zod";

import {
  DiscordProjectionConfigurationError,
  DiscordProjectionConflictError,
} from "./discordjs-projection-client.js";

export function toDiscordPublicationFailure(error: unknown): StageFailure {
  if (error instanceof DiscordProjectionConflictError) {
    return {
      code: "DISCORD_PUBLICATION_CONFLICT",
      message: "Discord publication has multiple projections for the same idempotency key",
      retryable: false,
    };
  }

  if (error instanceof DiscordProjectionConfigurationError) {
    return {
      code: "DISCORD_PUBLICATION_CONFIGURATION",
      message: error.message,
      retryable: false,
    };
  }

  if (error instanceof ZodError) {
    return {
      code: "DISCORD_PUBLICATION_INVALID_INPUT",
      message: "Discord publication request is invalid",
      retryable: false,
    };
  }

  const status = readProviderStatus(error);
  return {
    code: "DISCORD_PUBLICATION_REQUEST_FAILED",
    message: "Discord publication request failed",
    retryable:
      status === undefined ||
      status === 404 ||
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      status >= 500,
  };
}

function readProviderStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }

  const { status } = error;
  return typeof status === "number" && Number.isSafeInteger(status) ? status : undefined;
}
