import { describe, expect, it, vi } from "vitest";

import { loadPostgresMigrations } from "../src/postgres-migrations.js";
import { assertQuestionBindingFenceDefinition } from
  "../src/postgres-question-binding-fence-readiness.js";
import { durableQuestionRecoveryRetryReason,
  reconciliationDispositionForRecoveryReason } from
  "../src/postgres-question-recovery-codec.js";

describe("PostgreSQL question binding fence readiness contract", () => {
  it("binds startup readiness to the exact forward-migration function body", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      definition_matches: true, dependency_matches: true, wiring_matches: true,
    }] });
    await expect(assertQuestionBindingFenceDefinition(
      { query } as never, await loadPostgresMigrations(),
    )).resolves.toBeUndefined();
    const expectedSource = query.mock.calls[0]?.[1]?.[0] as string;
    expect(expectedSource).toContain("pre_canonical_text");
    expect(expectedSource).toContain("NEW.binding = expected_binding");
    expect(expectedSource).toContain("question retrieval binding is immutable");
  });
});

describe("PostgreSQL question recovery disposition contract", () => {
  it("uses one durable retry reason across lease and reconciliation discovery", () => {
    expect(durableQuestionRecoveryRetryReason("binding_structurally_corrupt"))
      .toBe("reconciliation:binding_structurally_corrupt");
  });

  it("keeps only derivable legacy authority actionable", () => {
    expect(reconciliationDispositionForRecoveryReason(
      "protocol2_canonical_evidence_filters_absent",
    )).toBe("reconcile");
    expect(reconciliationDispositionForRecoveryReason(
      "legacy_provenance_authority_conflict",
    )).toBe("reconcile");
    expect(reconciliationDispositionForRecoveryReason(
      "binding_structurally_corrupt",
    )).toBe("quarantined");
    expect(reconciliationDispositionForRecoveryReason(
      "binding_row_identity_conflict",
    )).toBe("quarantined");
  });
});
