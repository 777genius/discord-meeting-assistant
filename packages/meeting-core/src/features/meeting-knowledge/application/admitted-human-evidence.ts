import type { FinalReplyEvidencePort } from "./ports/final-reply.js";

export function admittedHumanActors(
  evidence: Extract<
    Awaited<ReturnType<FinalReplyEvidencePort["rehydrateSelectedEvidence"]>>,
    { readonly status: "current" }
  >,
): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...evidence.binding.humanActorIds,
      ...evidence.turns.map(({ speakerId }) => speakerId),
    ]),
  ].toSorted());
}
