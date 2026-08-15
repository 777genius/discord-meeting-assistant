ALTER TABLE meeting_core.answer_effects
  ADD COLUMN delivery_container_id text;

UPDATE meeting_core.answer_effects
SET delivery_container_id = projection_target_container_id
WHERE delivery_container_id IS NULL;

ALTER TABLE meeting_core.answer_effects
  ALTER COLUMN delivery_container_id SET NOT NULL;

COMMENT ON COLUMN meeting_core.answer_effects.projection_target_container_id IS
  'Canonical projection scope used for authority and deletion fencing.';
COMMENT ON COLUMN meeting_core.answer_effects.delivery_container_id IS
  'Actual immutable question/reply container used for create and reconciliation.';
