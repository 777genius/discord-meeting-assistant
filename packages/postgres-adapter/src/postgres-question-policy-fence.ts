import type { PoolClient } from "pg";

export interface QuestionPolicyIdentity {
  readonly authorizationPolicyVersion: string;
  readonly policyEpoch: number;
  readonly policyVersion: string;
}

interface StoredQuestionPolicyRow {
  readonly authorization_policy_version: string;
  readonly policy_epoch: number;
  readonly policy_version: string;
}

function requirePolicyIdentity(input: QuestionPolicyIdentity): QuestionPolicyIdentity {
  if (!Number.isSafeInteger(input.policyEpoch) || input.policyEpoch < 1) {
    throw new RangeError("question policy epoch must be a positive safe integer");
  }
  for (const [field, value] of [
    ["policyVersion", input.policyVersion],
    ["authorizationPolicyVersion", input.authorizationPolicyVersion],
  ] as const) {
    if (value.length === 0 || value.length > 256) {
      throw new RangeError(`${field} must contain between 1 and 256 characters`);
    }
  }
  return Object.freeze({ ...input });
}

function samePolicy(
  row: StoredQuestionPolicyRow,
  policy: QuestionPolicyIdentity,
): boolean {
  return row.policy_epoch === policy.policyEpoch &&
    row.policy_version === policy.policyVersion &&
    row.authorization_policy_version === policy.authorizationPolicyVersion;
}

/** Owns the monotonic durable policy epoch used by admission and workers. */
export class PostgresQuestionPolicyFence {
  public readonly identity: QuestionPolicyIdentity;

  public constructor(identity: QuestionPolicyIdentity) {
    this.identity = requirePolicyIdentity(identity);
  }

  /**
   * Activates only a newer epoch and retains a row lock through the caller's
   * transaction, so admission/lease cannot race a policy switch.
   */
  public async lockCurrent(client: PoolClient): Promise<boolean> {
    const activated = await client.query<StoredQuestionPolicyRow>(
      `
        INSERT INTO meeting_knowledge.current_question_policy (
          policy_key, policy_epoch, policy_version, authorization_policy_version
        ) VALUES ('local-final-reply', $1, $2, $3)
        ON CONFLICT (policy_key) DO UPDATE
        SET policy_epoch = EXCLUDED.policy_epoch,
            policy_version = EXCLUDED.policy_version,
            authorization_policy_version = EXCLUDED.authorization_policy_version,
            activated_at = transaction_timestamp()
        WHERE meeting_knowledge.current_question_policy.policy_epoch < EXCLUDED.policy_epoch
        RETURNING policy_epoch::float8 AS policy_epoch, policy_version,
                  authorization_policy_version
      `,
      [
        this.identity.policyEpoch,
        this.identity.policyVersion,
        this.identity.authorizationPolicyVersion,
      ],
    );
    const row = activated.rows[0] ?? (await client.query<StoredQuestionPolicyRow>(
      `
        SELECT policy_epoch::float8 AS policy_epoch, policy_version,
               authorization_policy_version
        FROM meeting_knowledge.current_question_policy
        WHERE policy_key = 'local-final-reply'
        FOR SHARE
      `,
    )).rows[0];
    if (row === undefined) {
      throw new Error("current question policy disappeared during activation");
    }
    if (row.policy_epoch === this.identity.policyEpoch && !samePolicy(row, this.identity)) {
      throw new Error("question policy epoch is bound to conflicting versions");
    }
    return samePolicy(row, this.identity);
  }
}
