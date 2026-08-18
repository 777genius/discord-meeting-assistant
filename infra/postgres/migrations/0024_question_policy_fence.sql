CREATE TABLE meeting_knowledge.current_question_policy (
  policy_key text PRIMARY KEY,
  policy_epoch bigint NOT NULL,
  policy_version text NOT NULL,
  authorization_policy_version text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT current_question_policy_key_is_supported
    CHECK ((policy_key = 'local-final-reply') IS TRUE),
  CONSTRAINT current_question_policy_identity_is_valid
    CHECK ((
      policy_epoch >= 1 AND
      length(policy_version) BETWEEN 1 AND 256 AND
      length(authorization_policy_version) BETWEEN 1 AND 256
    ) IS TRUE)
);

ALTER TABLE meeting_knowledge.question_jobs
  ADD COLUMN policy_epoch bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT question_jobs_policy_epoch_is_valid
    CHECK ((policy_epoch >= 1) IS TRUE);

COMMENT ON TABLE meeting_knowledge.current_question_policy IS
  'Monotonic cluster-wide policy fence for local final-reply admission and workers.';
