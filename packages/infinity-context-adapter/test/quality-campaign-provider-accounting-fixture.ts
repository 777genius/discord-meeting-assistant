import { assertQualificationProviderAccounting, qualificationExecutionBinding,
  type CallKind, type QualificationProviderAccounting, type QualityCampaignRelease } from
  "@discord-meeting/infinity-context-adapter/quality-campaign";

export function qualificationProviderAccountingFixture(release: QualityCampaignRelease,
  callKind: CallKind, overrides: Partial<Pick<QualificationProviderAccounting,
  "candidateCount" | "original" | "repair" | "resolver">> = {}):
QualificationProviderAccounting {
  const zero = Object.freeze({ callCount: 0, inputUtf8Bytes: 0, outputBytes: 0 });
  const one = Object.freeze({ callCount: 1, inputUtf8Bytes: 1, outputBytes: 1 });
  const defaults = { candidateCount: callKind === "retrieval" ? 1 : 0,
    original: ["adjudicator_1", "adjudicator_2", "answer"].includes(callKind) ? one : zero,
    repair: zero, resolver: callKind === "resolver" ? one : zero };
  return assertQualificationProviderAccounting({ ...qualificationExecutionBinding(release),
    ...defaults, ...overrides, neighborRadius: 0,
    schemaVersion: "meeting_knowledge.semantic_quality_provider_accounting.v1" },
  { callKind, release });
}
