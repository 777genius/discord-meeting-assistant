import { assertInfinityContextSearchActivation,
  type InfinityContextProductionQualificationPolicyV1 } from
  "@discord-meeting/infinity-context-adapter";
import type { Logger } from "@discord-meeting/observability-adapter";

import type { PlatformConfig } from "../config.js";

export function semanticSearchQualified(
  activation: NonNullable<PlatformConfig["infinityContext"]>["activation"],
  logger: Logger,
  productionQualification: InfinityContextProductionQualificationPolicyV1,
): boolean {
  try {
    assertInfinityContextSearchActivation(activation, productionQualification);
    return true;
  } catch (error) {
    logger.warn(
      "Infinity semantic search qualification unavailable; deletion drain remains active",
      { errorType: error instanceof Error ? error.name : "unknown" },
    );
    return false;
  }
}
