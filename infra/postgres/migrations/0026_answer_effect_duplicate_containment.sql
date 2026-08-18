ALTER TABLE meeting_core.answer_effects
  ADD COLUMN containment_receipts text[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE meeting_core.answer_effects
  ADD CONSTRAINT answer_effects_containment_receipts_are_bounded
    CHECK ((cardinality(containment_receipts) BETWEEN 0 AND 1000) IS TRUE),
  ADD CONSTRAINT answer_effects_containment_state_is_consistent
    CHECK (((cardinality(containment_receipts) = 0) OR (
      state = 'retraction_pending' AND
      external_receipt IS NOT NULL AND
      cardinality(containment_receipts) >= 2 AND
      containment_receipts[1] = external_receipt AND
      array_position(containment_receipts, NULL) IS NULL
    )) IS TRUE);

COMMENT ON COLUMN meeting_core.answer_effects.containment_receipts IS
  'Bounded exact duplicate remote receipts durably retained until all are retracted.';
