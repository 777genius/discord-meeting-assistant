import { createHash } from "node:crypto";

import {
  isLegacyQuestionBinding,
  type FocusedRetrievalAudit,
  type QuestionBindingSnapshot,
} from "@discord-meeting/meeting-core/meeting-knowledge";

interface PersistedFocusedEvidenceProvenance {
  readonly retrievalAudit?: FocusedRetrievalAudit | undefined;
  readonly source?: {
    readonly historicalSource?: { readonly candidateLocator: string } | undefined;
  } | undefined;
  readonly turnId: string;
}

/** Rejects structurally valid provenance unless its request and selected result are exact. */
export function focusedRetrievalProvenanceBinds(
  evidence: readonly PersistedFocusedEvidenceProvenance[],
  binding: QuestionBindingSnapshot,
  questionText: string,
): boolean {
  if (isLegacyQuestionBinding(binding) || evidence.length === 0) {return false;}
  const requestDigests = new Set(evidence.map(({ retrievalAudit }) =>
    retrievalAudit?.requestDigest
  ));
  return requestDigests.size === 1 && !requestDigests.has(undefined) &&
    evidence.every(({ retrievalAudit, source, turnId }) => {
      if (retrievalAudit === undefined || retrievalAudit.responseDigest !==
        canonicalJsonDigest({ contributions: retrievalAudit.contributions,
          fusedScore: retrievalAudit.fusedScore, locator: retrievalAudit.locator,
          providerRank: retrievalAudit.providerRank })) {return false;}
      if (binding.retrievalBinding.retrievalPath === "infinity_locator_v2") {
        return retrievalAudit.capabilityFingerprint ===
            binding.retrievalBinding.request.binding.capabilityFingerprint &&
          retrievalAudit.profileId === binding.retrievalBinding.request.binding.profileId &&
          retrievalAudit.requestDigest === canonicalJsonDigest(
            binding.retrievalBinding.request,
          ) && (source?.historicalSource === undefined ||
            retrievalAudit.locator === source.historicalSource.candidateLocator);
      }
      return binding.retrievalBinding.retrievalPath ===
          "canonical_local_exact_lexical_v1" &&
        retrievalAudit.capabilityFingerprint === binding.retrievalBinding.profileFingerprint &&
        retrievalAudit.profileId === binding.retrievalBinding.retrievalPath &&
        retrievalAudit.requestDigest === canonicalJsonDigest({ question: questionText,
          retrievalBinding: binding.retrievalBinding }) &&
        retrievalAudit.locator === `canonical-turn:${turnId}`;
    });
}

function canonicalJsonDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8")
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonicalValue);}
  if (typeof value !== "object" || value === null) {return value;}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, nested]) => [key, canonicalValue(nested)]));
}
