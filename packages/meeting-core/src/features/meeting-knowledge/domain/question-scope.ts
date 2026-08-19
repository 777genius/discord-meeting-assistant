import { classifyHistoricalGroundingMode } from "./grounding-mode.js";

/**
 * Focused memory can ground selected facts but does not deterministically prove
 * absence, a global count, or exhaustive recall across a source generation.
 */
export function requiresExhaustiveCoverage(question: string): boolean {
  return classifyHistoricalGroundingMode(question) === "exhaustive_coverage";
}
