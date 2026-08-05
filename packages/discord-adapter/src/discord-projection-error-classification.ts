import { DiscordAPIError } from "discord.js";
import { ZodError } from "zod";

import {
  DiscordProjectionConfigurationError,
  DiscordProjectionConflictError,
} from "./discordjs-projection-client.js";

const unknownChannel = 10_003;
const unknownMessage = 10_008;
const threadArchived = 50_083;

/**
 * A direct edit normally avoids expensive marker reconciliation. We only pay
 * that cost when the reference is demonstrably stale or the remote result is
 * ambiguous. Known Discord responses are safe to surface to the caller.
 */
export function shouldReconcileDirectProjectionEditFailure(error: unknown): boolean {
  if (isReconcilableDiscordEntity(error)) {
    return true;
  }
  if (
    error instanceof DiscordProjectionConfigurationError ||
    error instanceof DiscordProjectionConflictError ||
    error instanceof ZodError ||
    hasKnownProviderStatus(error)
  ) {
    return false;
  }
  return true;
}

export function isConfirmedMissingDiscordProjection(error: unknown): boolean {
  return providerErrorCode(error) === unknownChannel
    || providerErrorCode(error) === unknownMessage;
}

function isReconcilableDiscordEntity(error: unknown): boolean {
  if (error instanceof DiscordAPIError) {
    return error.code === unknownChannel ||
      error.code === unknownMessage ||
      error.code === threadArchived;
  }
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const { code } = error;
  return code === unknownChannel || code === unknownMessage || code === threadArchived;
}

function providerErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function hasKnownProviderStatus(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return false;
  }
  const { status } = error;
  return typeof status === "number" && Number.isSafeInteger(status);
}
