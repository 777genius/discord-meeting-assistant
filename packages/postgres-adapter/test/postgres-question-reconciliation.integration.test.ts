import { QuestionBinding, type QuestionBindingSnapshot } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresFinalReplyMaintenance, PostgresQuestionJobStore,
  PostgresSchemaReadiness } from "../src/index.js";
import { databaseOrSkip, usePostgresIntegrationDatabase } from
  "./postgres-integration-fixtures.js";
import { questionAdmissionBindingHash } from
  "../src/postgres-meeting-knowledge-codecs.js";
import { questionReconciliationPageSql } from
  "../src/postgres-question-reconciliation-checkpoint.js";
import { canonicalFixtureHash, exactPreCompositeFixture,
  serializeQuestionReconciliationFixtureRows } from
  "./postgres-protocol2-recovery.fixture.js";

const questionPolicy = Object.freeze({
  authorizationPolicyVersion: "discord.participant-current-results.v1",
  policyEpoch: 1,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
});

usePostgresIntegrationDatabase();

describe("PostgreSQL question reconciliation retention", () => {
  it("persists a resumable cursor and deletes expired mutation tombstones in bounded work",
    async (context) => {
      const database = databaseOrSkip(context);
      const jobs = new PostgresQuestionJobStore(database, questionPolicy);
      await database.query(`UPDATE meeting_knowledge.question_reconciliation_checkpoints
        SET after_question_id = NULL WHERE checkpoint_key = 'discord-active-questions-v1'`);
      await database.query(
        `INSERT INTO meeting_knowledge.question_message_tombstones
           (question_id, mutation_kind, observed_at, expires_at)
         VALUES ($1, 'edit', transaction_timestamp() - interval '2 hours',
           transaction_timestamp() - interval '1 hour'),
           ($2, 'delete', transaction_timestamp(), transaction_timestamp() + interval '1 day')`,
        ["77777777777777770", "77777777777777773"],
      );

      expect(await jobs.loadQuestionReconciliationCursor()).toBeNull();
      await expect(jobs.saveQuestionReconciliationCursor({ expectedAfterQuestionId: null,
        nextAfterQuestionId: "77777777777777771" })).resolves.toBe(true);
      await expect(jobs.saveQuestionReconciliationCursor({ expectedAfterQuestionId: null,
        nextAfterQuestionId: "77777777777777772" })).resolves.toBe(false);
      expect(await jobs.loadQuestionReconciliationCursor()).toBe("77777777777777771");

      await new PostgresFinalReplyMaintenance(database, questionPolicy).maintain({
        maximumJobs: 100, servingEnabled: true });
      const retained = await database.query<{ readonly mutation_kind: string;
        readonly question_id: string }>(`SELECT question_id, mutation_kind
          FROM meeting_knowledge.question_message_tombstones ORDER BY question_id`);
      expect(retained.rows).toEqual([{
        mutation_kind: "delete", question_id: "77777777777777773" }]);
      await expect(jobs.saveQuestionReconciliationCursor({
        expectedAfterQuestionId: "77777777777777771", nextAfterQuestionId: null,
      })).resolves.toBe(true);
    });
});

describe("PostgreSQL question reconciliation readiness", () => {
  it("converges an active job whose effect was delivered by reconciliation",
    async (context) => {
      const database = databaseOrSkip(context);
      const question = currentBinding("77777777777777501");
      await database.query(`INSERT INTO meeting_knowledge.question_jobs (
        question_id, requester_subject, question_hash, scope_id,
        final_projection_receipt, authorization_principal_ref,
        authorization_digest, locale, question_text, binding, binding_hash,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'en', 'Question?', $8, $9,
        transaction_timestamp() + interval '30 minutes')`,
      [question.questionId, question.requesterSubject, question.questionHash,
        question.scopeId, question.finalProjectionReceipt,
        question.authorizationPrincipalRef, question.authorizationDigest,
        question, questionAdmissionBindingHash(question)]);
      const payload = JSON.stringify({ content: "reconciled answer" });
      await database.query(`INSERT INTO meeting_core.answer_effects (
        effect_id, state, authority_scope_id, projection_target_container_id,
        delivery_container_id, reply_to_remote_message_id, marker,
        payload_bytes, payload_hash, binding_hash, authorization_digest,
        source_meeting_ids, request_started_at, external_receipt, settled_at
      ) VALUES ('meeting-knowledge-answer:v1:' || $1, 'delivered', $2, $3, $3,
        $1, 'marker:' || $1, $4, $5, $6, $7, ARRAY[$8],
        transaction_timestamp(), 'discord-reconciled', transaction_timestamp())`,
      [question.questionId, question.scopeId, question.deliveryContainerId,
        payload, createHash("sha256").update(payload).digest("hex"),
        questionAdmissionBindingHash(question), question.authorizationDigest,
        question.meetingId]);
      const jobs = new PostgresQuestionJobStore(database, questionPolicy);
      await expect(jobs.listActiveQuestionsForReconciliation({
        afterQuestionId: null, maximumRows: 10,
      })).resolves.toEqual([expect.objectContaining({ questionId: question.questionId })]);
      await expect(jobs.convergeDeliveredQuestion(question.questionId)).resolves.toBe(true);
      await expect(jobs.listActiveQuestionsForReconciliation({
        afterQuestionId: null, maximumRows: 10,
      })).resolves.toEqual([]);
      await expect(database.query(`SELECT state, outcome, binding, question_text
        FROM meeting_knowledge.question_jobs WHERE question_id = $1`,
      [question.questionId])).resolves.toMatchObject({ rows: [{ binding: null,
        outcome: "answered", question_text: null, state: "terminal" }] });
    });
});

describe("PostgreSQL question reconciliation enumeration readiness", () => {
  it("streams every ambiguous answer effect even after its question terminalizes",
    async (context) => {
      const database = databaseOrSkip(context);
      const states = ["request_started", "outcome_unknown",
        "absent_unconfirmed"] as const;
      for (const [index, state] of states.entries()) {
        const questionId = String(77_777_777_777_777_610n + BigInt(index));
        await database.query(`INSERT INTO meeting_knowledge.question_jobs (
          question_id, requester_subject, question_hash, scope_id,
          final_projection_receipt, authorization_digest, locale, binding_hash,
          state, outcome, terminal_at, scrubbed_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'en', $7, 'terminal', 'delivery_unknown',
          transaction_timestamp(), transaction_timestamp(),
          transaction_timestamp() + interval '30 minutes')`,
        [questionId, "d".repeat(64), "c".repeat(64), "66666666666666666",
          "discord:v2:channel:22222222222222222:message:44444444444444444",
          "a".repeat(64), "b".repeat(64)]);
        const payload = JSON.stringify({ content: `ambiguous-${index}` });
        await database.query(`INSERT INTO meeting_core.answer_effects (
          effect_id, state, authority_scope_id, projection_target_container_id,
          delivery_container_id, reply_to_remote_message_id, marker,
          payload_bytes, payload_hash, binding_hash, authorization_digest,
          source_meeting_ids, request_started_at
        ) VALUES ('meeting-knowledge-answer:v1:' || $1, $2, $3, $4, $4, $1,
          'marker:' || $1, $5, $6, $7, $8, ARRAY['meeting-ambiguous'],
          transaction_timestamp())`,
        [questionId, state, "66666666666666666", "22222222222222222", payload,
          createHash("sha256").update(payload).digest("hex"), "b".repeat(64),
          "a".repeat(64)]);
      }
      const rows = await new PostgresQuestionJobStore(database, questionPolicy)
        .listActiveQuestionsForReconciliation({ afterQuestionId: null,
          maximumRows: 10 });
      expect(rows.map(({ questionId }) => questionId)).toEqual(states.map((_state, index) =>
        String(77_777_777_777_777_610n + BigInt(index))));
      expect(rows.every(({ reconciliationDisposition }) =>
        reconciliationDisposition === "reconcile")).toBe(true);
    });

  it("uses bounded partial eligible indexes with a sparse terminal corpus",
    async (context) => {
      const database = databaseOrSkip(context);
      await database.query(`INSERT INTO meeting_knowledge.question_jobs (
        question_id, requester_subject, question_hash, scope_id,
        final_projection_receipt, authorization_digest, locale, binding_hash,
        state, outcome, terminal_at, scrubbed_at, expires_at
      ) SELECT (78000000000000000::bigint + item)::text, $1, $2, $3, $4, $5,
          'en', $6, 'terminal', 'answered', transaction_timestamp(),
          transaction_timestamp(), transaction_timestamp() + interval '30 minutes'
        FROM generate_series(1, 20000) AS item`,
      ["d".repeat(64), "c".repeat(64), "66666666666666666",
        "discord:v2:channel:22222222222222222:message:44444444444444444",
        "a".repeat(64), "b".repeat(64)]);
      const reservedPayload = '{"content":"not-actionable"}';
      await database.query(`INSERT INTO meeting_core.answer_effects (
        effect_id, authority_scope_id, projection_target_container_id,
        delivery_container_id, reply_to_remote_message_id, marker,
        payload_bytes, payload_hash, binding_hash, authorization_digest,
        source_meeting_ids
      ) SELECT 'meeting-knowledge-answer:v1:' ||
          (78000000000000000::bigint + item)::text,
          $1, $2, $2, (78000000000000000::bigint + item)::text,
          'marker:' || item::text, $3, $4, $5, $6,
          ARRAY['meeting-sparse'] FROM generate_series(1, 20000) AS item`,
      ["66666666666666666", "22222222222222222", reservedPayload,
        createHash("sha256").update(reservedPayload).digest("hex"),
        "b".repeat(64), "a".repeat(64)]);
      const active = currentBinding("79999999999999999");
      await database.query(`INSERT INTO meeting_knowledge.question_jobs (
        question_id, requester_subject, question_hash, scope_id,
        final_projection_receipt, authorization_principal_ref,
        authorization_digest, locale, question_text, binding, binding_hash,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'en', 'Question?', $8, $9,
        transaction_timestamp() + interval '30 minutes')`,
      [active.questionId, active.requesterSubject, active.questionHash, active.scopeId,
        active.finalProjectionReceipt, active.authorizationPrincipalRef,
        active.authorizationDigest, active, questionAdmissionBindingHash(active)]);
      await database.query("ANALYZE meeting_knowledge.question_jobs");
      await database.query("ANALYZE meeting_core.answer_effects");
      const client = await database.connect();
      let explained: { readonly rows: readonly { readonly "QUERY PLAN": unknown }[] };
      try {
        explained = await client.query<{ "QUERY PLAN": unknown }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${questionReconciliationPageSql}`,
          [null, 10]);
      } finally {
        client.release();
      }
      const plan = JSON.stringify(explained.rows[0]?.["QUERY PLAN"]);
      expect(plan).toContain("question_jobs_reconciliation_active_idx");
      expect(plan).toContain("answer_effects_question_reconciliation_idx");
      expect(plan).not.toMatch(
        /"Node Type":"Seq Scan"[^}]*"Relation Name":"(?:question_jobs|answer_effects)"/u,
      );
      const planNodes = flattenPlanNodes(explained.rows[0]?.["QUERY PLAN"]);
      for (const indexName of ["question_jobs_reconciliation_active_idx",
        "answer_effects_question_reconciliation_idx"]) {
        const scans = planNodes.filter((node) => node["Index Name"] === indexName);
        expect(scans.length).toBeGreaterThan(0);
        expect(scans.every((node) =>
          node["Node Type"] === "Index Scan" ||
          node["Node Type"] === "Index Only Scan")).toBe(true);
        expect(scans.every((node) => Number(node["Actual Rows"]) <= 10)).toBe(true);
      }
      const page = await new PostgresQuestionJobStore(database, questionPolicy)
        .listActiveQuestionsForReconciliation({ afterQuestionId: null,
          maximumRows: 10 });
      expect(page.map(({ questionId }) => questionId)).toEqual([active.questionId]);
    });

  it("upgrades one exact legacy binding once under concurrent leases without starving the queue",
    async (context) => {
      const database = databaseOrSkip(context);
      const legacyCurrent = currentBinding("77777777777777601");
      const current = currentBinding("77777777777777602");
      const preCanonicalCurrent = currentBinding("77777777777777603");
      if (!("retrievalBinding" in legacyCurrent) ||
        !("retrievalBinding" in preCanonicalCurrent)) {
        throw new Error("protocol-2 fixture is unavailable");
      }
      const retrieval = legacyCurrent.retrievalBinding;
      const legacy = { ...legacyCurrent, retrievalBinding: {
        canonicalEvidenceFilters: retrieval.canonicalEvidenceFilters,
        cutoverEpoch: retrieval.cutoverEpoch,
        profileFingerprint: retrieval.profileFingerprint,
        retrievalPath: "canonical_local_exact_lexical_v1" as const,
      } };
      const { authorizationPrincipalRef: _principal, ...legacyDedupe } = legacy;
      const preCanonicalLegacy = { ...preCanonicalCurrent, retrievalBinding: {
        canonicalEvidenceFilters: preCanonicalCurrent.retrievalBinding
          .canonicalEvidenceFilters,
        cutoverEpoch: preCanonicalCurrent.retrievalBinding.cutoverEpoch,
        profileFingerprint: preCanonicalCurrent.retrievalBinding.profileFingerprint,
        retrievalPath: "canonical_local_exact_lexical_v1" as const,
      } };
      const { authorizationPrincipalRef: _preCanonicalPrincipal,
        ...preCanonicalDedupe } = preCanonicalLegacy;
      const rows = [
        { binding: legacy, bindingHash: canonicalFixtureHash(legacyDedupe),
          questionId: legacyCurrent.questionId },
        { binding: current, bindingHash: questionAdmissionBindingHash(current),
          questionId: current.questionId },
        { binding: preCanonicalLegacy,
          bindingHash: createHash("sha256").update(JSON.stringify(preCanonicalDedupe))
            .digest("hex"), questionId: preCanonicalCurrent.questionId },
      ];
      for (const row of rows) {
        await database.query(`INSERT INTO meeting_knowledge.question_jobs (
          question_id, requester_subject, question_hash, scope_id,
          final_projection_receipt, authorization_principal_ref,
          authorization_digest, locale, question_text, binding, binding_hash,
          policy_epoch, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'en', 'Question?', $8, $9, 1,
          transaction_timestamp() + interval '30 minutes')`,
        [row.questionId, "d".repeat(64), "c".repeat(64), "66666666666666666",
          "discord:v2:channel:22222222222222222:message:44444444444444444",
          "principal:restart", "a".repeat(64), row.binding, row.bindingHash]);
      }

      const adversarialUpgrade = QuestionBinding.create({ ...legacyCurrent,
        retrievalBinding: { ...legacyCurrent.retrievalBinding,
          cutoverEpoch: "adversarial-cutover" } } as QuestionBindingSnapshot).toSnapshot();
      await expect(database.query(`UPDATE meeting_knowledge.question_jobs
        SET binding = $2::jsonb, binding_hash = $3
        WHERE question_id = $1`, [legacyCurrent.questionId, adversarialUpgrade,
        questionAdmissionBindingHash(adversarialUpgrade)]))
        .rejects.toThrow("question retrieval binding is immutable");

      const stores = [new PostgresQuestionJobStore(database, questionPolicy),
        new PostgresQuestionJobStore(database, questionPolicy),
        new PostgresQuestionJobStore(database, questionPolicy)];
      const leased = await Promise.all(stores.map(async (store, index) =>
        await store.leaseNext({ leaseSeconds: 60, maximumProviderAttempts: 2,
          workerId: `legacy-upgrade-${index}` })));
      expect(new Set(leased.map((lease) => lease?.jobId))).toEqual(
        new Set(rows.map(({ questionId }) => questionId)));
      expect(leased.find((lease) => lease?.jobId === legacyCurrent.questionId)?.binding)
        .toEqual(legacyCurrent);
      const persisted = await database.query<{ binding: unknown; binding_hash: string }>(
        `SELECT binding, binding_hash FROM meeting_knowledge.question_jobs
         WHERE question_id = $1`, [legacyCurrent.questionId]);
      expect(persisted.rows[0]).toEqual({ binding: legacyCurrent,
        binding_hash: questionAdmissionBindingHash(legacyCurrent) });
      await expect(database.query(`SELECT binding, binding_hash
        FROM meeting_knowledge.question_jobs WHERE question_id = $1`,
      [preCanonicalCurrent.questionId])).resolves.toMatchObject({ rows: [{
        binding: preCanonicalCurrent,
        binding_hash: questionAdmissionBindingHash(preCanonicalCurrent),
      }] });

      const firstLegacyLease = leased.find((lease) =>
        lease?.jobId === legacyCurrent.questionId);
      if (firstLegacyLease === undefined || firstLegacyLease === null) {
        throw new Error("legacy upgrade lease fixture is unavailable");
      }
      await database.query(`UPDATE meeting_knowledge.question_jobs
        SET lease_until = transaction_timestamp() - interval '1 second'
        WHERE question_id = $1`, [legacyCurrent.questionId]);
      const resumed = await stores[0]!.leaseNext({ leaseSeconds: 60,
        maximumProviderAttempts: 2, workerId: "legacy-upgrade-restart" });
      expect(resumed).toMatchObject({ binding: legacyCurrent,
        generation: firstLegacyLease.generation + 1,
        jobId: legacyCurrent.questionId });
      await expect(database.query(`SELECT binding, binding_hash
        FROM meeting_knowledge.question_jobs WHERE question_id = $1`,
      [legacyCurrent.questionId])).resolves.toMatchObject({ rows: [{
        binding: legacyCurrent,
        binding_hash: questionAdmissionBindingHash(legacyCurrent),
      }] });

      await expect(database.query(`UPDATE meeting_knowledge.question_jobs
        SET binding = jsonb_set(binding, '{retrievalBinding,cutoverEpoch}', '"mutated"')
        WHERE question_id = $1`, [legacyCurrent.questionId]))
        .rejects.toThrow("question retrieval binding is immutable");
      await expect(database.query(`UPDATE meeting_knowledge.question_jobs
        SET binding_hash = $2 WHERE question_id = $1`,
      [legacyCurrent.questionId, "f".repeat(64)]))
        .rejects.toThrow("question retrieval binding is immutable");
    });
});

describe("PostgreSQL question reconciliation restart readiness", () => {
  it("rejects migration 0039-0043 checkpoint, quarantine, and index drift",
    async (context) => {
    const database = databaseOrSkip(context);
    await database.query(`ALTER TABLE meeting_knowledge.question_message_tombstones
      DROP CONSTRAINT question_message_tombstones_expiry_is_bounded`);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "required PostgreSQL check constraint is missing or invalid");
    } finally {
      await database.query(`ALTER TABLE meeting_knowledge.question_message_tombstones
        ADD CONSTRAINT question_message_tombstones_expiry_is_bounded
        CHECK ((expires_at > observed_at AND
          expires_at <= observed_at + interval '7 days') IS TRUE)`);
    }
    await database.query(`DROP INDEX meeting_knowledge.question_message_tombstones_expiry_idx`);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "required PostgreSQL index is missing or invalid");
    } finally {
      await database.query(`CREATE INDEX question_message_tombstones_expiry_idx
        ON meeting_knowledge.question_message_tombstones (expires_at, question_id)`);
    }
    await database.query(`ALTER TABLE meeting_knowledge.question_reconciliation_checkpoints
      DROP CONSTRAINT question_reconciliation_cursor_is_valid`);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "required PostgreSQL check constraint is missing or invalid");
    } finally {
      await database.query(`ALTER TABLE meeting_knowledge.question_reconciliation_checkpoints
        ADD CONSTRAINT question_reconciliation_cursor_is_valid
        CHECK ((after_question_id IS NULL OR after_question_id ~ '^[0-9]{17,20}$') IS TRUE)`);
    }
    await database.query(`ALTER TABLE meeting_knowledge.question_jobs
      DROP CONSTRAINT question_jobs_reconciliation_quarantine_is_consistent`);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "required PostgreSQL check constraint is missing or invalid");
    } finally {
      await database.query(`ALTER TABLE meeting_knowledge.question_jobs
        ADD CONSTRAINT question_jobs_reconciliation_quarantine_is_consistent
        CHECK (((reconciliation_disposition IS NULL AND
                 reconciliation_reason IS NULL) OR
                (reconciliation_disposition IN ('quarantined', 'reconcile') AND
                 reconciliation_reason ~ '^[a-z0-9_]{1,128}$' AND
                 state = 'terminal' AND outcome = 'stale_binding')) IS TRUE)`);
    }
    await database.query(`DROP INDEX
      meeting_knowledge.question_jobs_reconciliation_active_idx`);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "required PostgreSQL index is missing or invalid");
    } finally {
      await database.query(`CREATE INDEX question_jobs_reconciliation_active_idx
        ON meeting_knowledge.question_jobs (question_id)
        WHERE state <> 'terminal' OR reconciliation_disposition = 'reconcile'`);
    }
    await database.query(`DROP INDEX
      meeting_knowledge.question_jobs_reconciliation_active_idx`);
    await database.query(`CREATE INDEX question_jobs_reconciliation_active_idx
      ON meeting_knowledge.question_jobs (question_id, created_at)
      WHERE state <> 'terminal' OR reconciliation_disposition = 'reconcile'`);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "required PostgreSQL index definition is incorrect");
    } finally {
      await database.query(`DROP INDEX
        meeting_knowledge.question_jobs_reconciliation_active_idx`);
      await database.query(`CREATE INDEX question_jobs_reconciliation_active_idx
        ON meeting_knowledge.question_jobs (question_id)
        WHERE state <> 'terminal' OR reconciliation_disposition = 'reconcile'`);
    }
    const originalFunction = await database.query<{
      readonly definition: string;
    }>(`SELECT pg_get_functiondef(
          'meeting_knowledge.prevent_question_binding_mutation()'::regprocedure
        ) AS definition`);
    const definition = originalFunction.rows[0]?.definition;
    if (definition === undefined) {
      throw new Error("question binding trigger definition fixture is unavailable");
    }
    await database.query(`CREATE OR REPLACE FUNCTION
      meeting_knowledge.prevent_question_binding_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "question binding trigger definition does not match the safe upgrade fence");
    } finally {
      await database.query(definition);
    }
    const originalCanonical = await database.query<{ readonly definition: string }>(
      `SELECT pg_get_functiondef(
        'meeting_knowledge.canonical_jsonb_text(jsonb)'::regprocedure
      ) AS definition`,
    );
    const canonicalDefinition = originalCanonical.rows[0]?.definition;
    if (canonicalDefinition === undefined) {
      throw new Error("canonical JSON function fixture is unavailable");
    }
    await database.query(`CREATE OR REPLACE FUNCTION
      meeting_knowledge.canonical_jsonb_text(value jsonb)
      RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
      SET search_path = pg_catalog, meeting_knowledge
      AS $$ BEGIN RETURN value::text; END; $$`);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "question binding trigger canonical JSON dependency does not match");
    } finally {
      await database.query(canonicalDefinition);
    }
  });
});

describe("PostgreSQL question reconciliation crash recovery", () => {
  it("retains lease-terminalized poison quarantine without permanently re-enqueuing it",
    async (context) => {
      const database = databaseOrSkip(context);
      const questionId = "55555555555555554";
      await database.query(`INSERT INTO meeting_knowledge.question_jobs (
        question_id, requester_subject, question_hash, scope_id,
        final_projection_receipt, authorization_principal_ref,
        authorization_digest, locale, question_text, binding, binding_hash,
        policy_epoch, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'en', 'Question?', $8, $9, 1,
        transaction_timestamp() + interval '30 minutes')`,
      [questionId, "d".repeat(64), "c".repeat(64), "66666666666666666",
        "discord:v2:channel:22222222222222222:message:44444444444444444",
        "principal:restart", "a".repeat(64),
        { ...currentBinding(questionId), corrupt: true }, "6".repeat(64)]);
      const firstProcess = new PostgresQuestionJobStore(database, questionPolicy);
      await expect(firstProcess.leaseNext({ leaseSeconds: 60,
        maximumProviderAttempts: 2, workerId: "poison-terminalizer" }))
        .resolves.toBeNull();
      await expect(database.query(`SELECT retry_reason
        FROM meeting_knowledge.question_jobs WHERE question_id = $1`, [questionId]))
        .resolves.toMatchObject({ rows: [{
          retry_reason: "reconciliation:binding_structurally_corrupt",
        }] });

      const payload = JSON.stringify({ content: "already delivered" });
      await database.query(`INSERT INTO meeting_core.answer_effects (
        effect_id, state, authority_scope_id, projection_target_container_id,
        delivery_container_id, reply_to_remote_message_id, marker,
        payload_bytes, payload_hash, binding_hash, authorization_digest,
        source_meeting_ids, request_started_at, external_receipt, settled_at
      ) VALUES ('meeting-knowledge-answer:v1:' || $1, 'delivered', $2, $3, $3,
        $1, 'marker:' || $1, $4, $5, $6, $7, ARRAY['meeting-restart'],
        transaction_timestamp(), 'discord-receipt:' || $1,
        transaction_timestamp())`,
      [questionId, "66666666666666666", "22222222222222222", payload,
        createHash("sha256").update(payload).digest("hex"), "6".repeat(64),
        "a".repeat(64)]);

      const restarted = new PostgresQuestionJobStore(database, questionPolicy);
      const replay = await restarted.listActiveQuestionsForReconciliation({
        afterQuestionId: null, maximumRows: 100 });
      expect(replay).toEqual([]);
      const persisted = await database.query(`SELECT state, outcome, retry_reason,
          reconciliation_disposition, reconciliation_reason
        FROM meeting_knowledge.question_jobs WHERE question_id = $1`, [questionId]);
      expect(persisted.rows).toEqual([{
        outcome: "stale_binding",
        reconciliation_disposition: "quarantined",
        reconciliation_reason: "binding_structurally_corrupt",
        retry_reason: "reconciliation:binding_structurally_corrupt",
        state: "terminal",
      }]);
      const effects = await database.query<{ readonly count: number }>(
        `SELECT count(*)::integer AS count FROM meeting_core.answer_effects
         WHERE effect_id = 'meeting-knowledge-answer:v1:' || $1`, [questionId]);
      expect(effects.rows).toEqual([{ count: 1 }]);
    });

  it("restarts exhaustively across poison rows, delivered effects, crashes, and cursor CAS",
    async (context) => {
      const rows: Array<{ readonly binding: unknown; readonly bindingHash: string;
        readonly groundingPlan: unknown | null; readonly questionId: string;
        readonly state: "queued" | "terminal" }> =
        Array.from({ length: 403 }, (_, index) => {
        const questionId = String(77_000_000_000_000_000n + BigInt(index));
        if (index === 350 || index === 400) {
          return { binding: null, bindingHash: "7".repeat(64), groundingPlan: null,
            questionId, state: "terminal" };
        }
        const binding = currentBinding(questionId);
        return { binding, bindingHash: questionAdmissionBindingHash(binding),
          groundingPlan: null, questionId, state: "queued" };
        });
      const old = exactPreCompositeFixture();
      rows.push({ binding: old.binding, bindingHash: old.bindingHash,
        groundingPlan: old.groundingPlan, questionId: "33333333333333333",
        state: "queued" });
      rows.push({ binding: { bindingProtocolVersion: 2, corrupt: true },
        bindingHash: "6".repeat(64), groundingPlan: null,
        questionId: "55555555555555555", state: "queued" });
      const serializedRows = serializeQuestionReconciliationFixtureRows(rows);
      expect(serializedRows).toHaveLength(405);
      expect(Object.keys(serializedRows[0]!).toSorted()).toEqual([
        "binding", "binding_hash", "grounding_plan", "question_id", "state",
      ]);
      expect(serializedRows.map(({ question_id: questionId }) => questionId))
        .toEqual(rows.map(({ questionId }) => questionId));
      const database = databaseOrSkip(context);
      await database.query(`UPDATE meeting_knowledge.question_reconciliation_checkpoints
        SET after_question_id = NULL WHERE checkpoint_key = 'discord-active-questions-v1'`);
      await database.query(
        `INSERT INTO meeting_knowledge.question_jobs (
           question_id, requester_subject, question_hash, scope_id,
           final_projection_receipt, authorization_principal_ref,
           authorization_digest, locale, question_text, binding, binding_hash,
           grounding_plan, state, outcome, terminal_at, scrubbed_at, expires_at
         ) SELECT item.question_id, $2, $3, $4, $5,
             CASE WHEN item.state = 'terminal' THEN NULL ELSE 'principal:restart' END,
             $6, 'en',
             CASE WHEN item.state = 'terminal' THEN NULL ELSE 'Question?' END,
             item.binding, item.binding_hash, item.grounding_plan, item.state,
             CASE WHEN item.state = 'terminal' THEN 'answered' ELSE NULL END,
             CASE WHEN item.state = 'terminal' THEN transaction_timestamp() ELSE NULL END,
             CASE WHEN item.state = 'terminal' THEN transaction_timestamp() ELSE NULL END,
             transaction_timestamp() + interval '30 minutes'
           FROM jsonb_to_recordset($1::jsonb) AS item(
             question_id text, binding jsonb, binding_hash text,
             grounding_plan jsonb, state text
           )`,
        [JSON.stringify(serializedRows), "d".repeat(64), "c".repeat(64),
          "66666666666666666",
          "discord:v2:channel:22222222222222222:message:44444444444444444",
          "a".repeat(64)],
      );
      const deliveredIds = ["55555555555555555", rows[350]!.questionId,
        rows[400]!.questionId];
      for (const questionId of deliveredIds) {
        const payload = JSON.stringify({ content: "delivered", message_reference: {
          channel_id: "22222222222222222", message_id: questionId } });
        await database.query(
          `INSERT INTO meeting_core.answer_effects (
             effect_id, state, authority_scope_id,
             projection_target_container_id, delivery_container_id,
             reply_to_remote_message_id, marker, payload_bytes, payload_hash,
             binding_hash, authorization_digest, source_meeting_ids,
             request_started_at, external_receipt, settled_at
           ) VALUES (
             'meeting-knowledge-answer:v1:' || $1, 'delivered', $2, $3, $3,
             $1, 'marker:' || $1, $4, $5, $6, $7,
             ARRAY['meeting-restart'], transaction_timestamp(),
             'discord-receipt:' || $1, transaction_timestamp()
           )`,
          [questionId, "66666666666666666", "22222222222222222", payload,
            createHash("sha256").update(payload).digest("hex"), "7".repeat(64),
            "a".repeat(64)],
        );
      }

      const firstProcess = new PostgresQuestionJobStore(database, questionPolicy);
      const firstPage = await firstProcess.listActiveQuestionsForReconciliation({
        afterQuestionId: null, maximumRows: 100 });
      expect(firstPage).toHaveLength(100);
      expect(firstPage.find(({ questionId }) =>
        questionId === "33333333333333333")?.reconciliationDisposition)
        .toBe("reconcile");
      expect(firstPage.find(({ questionId }) =>
        questionId === "55555555555555555")?.reconciliationDisposition)
        .toBe("quarantined");
      // Simulated process loss before cursor save: restart must replay this page.
      const afterPreSaveCrash = new PostgresQuestionJobStore(database, questionPolicy);
      expect(await afterPreSaveCrash.loadQuestionReconciliationCursor()).toBeNull();
      const replayed = await afterPreSaveCrash.listActiveQuestionsForReconciliation({
        afterQuestionId: null, maximumRows: 100 });
      expect(replayed.map(({ questionId }) => questionId)).toEqual([
        ...firstPage.filter(({ questionId }) =>
          questionId !== "55555555555555555").map(({ questionId }) => questionId),
        rows[98]!.questionId,
      ]);
      expect(replayed.find(({ questionId }) =>
        questionId === "33333333333333333")?.reconciliationDisposition)
        .toBe("reconcile");
      expect(replayed.every(({ reconciliationDisposition }) =>
        reconciliationDisposition === "reconcile")).toBe(true);
      const pageOneCursor = replayed.at(-1)!.questionId;
      expect(await afterPreSaveCrash.saveQuestionReconciliationCursor({
        expectedAfterQuestionId: null, nextAfterQuestionId: pageOneCursor })).toBe(true);

      // Simulated loss after save but before next-page scheduling resumes at page two.
      const restarted = new PostgresQuestionJobStore(database, questionPolicy);
      expect(await restarted.loadQuestionReconciliationCursor()).toBe(pageOneCursor);
      const contender = new PostgresQuestionJobStore(database, questionPolicy);
      const concurrentCursor = await contender.loadQuestionReconciliationCursor();
      const concurrentPage = await contender.listActiveQuestionsForReconciliation({
        afterQuestionId: concurrentCursor, maximumRows: 100 });
      const pageTwo = await restarted.listActiveQuestionsForReconciliation({
        afterQuestionId: pageOneCursor, maximumRows: 100 });
      expect(concurrentPage.map(({ questionId }) => questionId))
        .toEqual(pageTwo.map(({ questionId }) => questionId));
      const pageTwoCursor = pageTwo.at(-1)!.questionId;
      const cas = await Promise.all([
        restarted.saveQuestionReconciliationCursor({
          expectedAfterQuestionId: pageOneCursor, nextAfterQuestionId: pageTwoCursor }),
        contender.saveQuestionReconciliationCursor({
          expectedAfterQuestionId: concurrentCursor, nextAfterQuestionId: pageTwoCursor }),
      ]);
      expect(cas.toSorted()).toEqual([false, true]);

      const durablePages = [...replayed, ...pageTwo];
      const observed = new Set([...firstPage, ...durablePages]
        .map(({ questionId }) => questionId));
      let cursor = await restarted.loadQuestionReconciliationCursor();
      while (cursor !== null) {
        const page = await restarted.listActiveQuestionsForReconciliation({
          afterQuestionId: cursor, maximumRows: 100 });
        for (const row of page) {
          durablePages.push(row);
          observed.add(row.questionId);
        }
        const next = page.length === 100 ? page.at(-1)!.questionId : null;
        expect(await restarted.saveQuestionReconciliationCursor({
          expectedAfterQuestionId: cursor, nextAfterQuestionId: next })).toBe(true);
        cursor = next;
      }
      expect(observed).toEqual(new Set(rows.filter(({ state }) => state !== "terminal")
        .map(({ questionId }) => questionId)));
      expect(new Set(durablePages.map(({ questionId }) => questionId)).size)
        .toBe(durablePages.length);
      expect(deliveredIds.map((questionId) => durablePages.filter((row) =>
        row.questionId === questionId).length)).toEqual([0, 0, 0]);
      const poison = await database.query<{ outcome: string;
        reconciliation_disposition: string; reconciliation_reason: string;
        retry_reason: string; state: string }>(`SELECT state, outcome, retry_reason,
            reconciliation_disposition, reconciliation_reason
          FROM meeting_knowledge.question_jobs
          WHERE question_id IN ('33333333333333333', '55555555555555555')
          ORDER BY question_id`);
      expect(poison.rows).toEqual([
        { outcome: "stale_binding",
          reconciliation_disposition: "reconcile",
          reconciliation_reason: "protocol2_canonical_evidence_filters_absent",
          retry_reason: "reconciliation:protocol2_canonical_evidence_filters_absent",
          state: "terminal" },
        { outcome: "stale_binding",
          reconciliation_disposition: "quarantined",
          reconciliation_reason: "binding_structurally_corrupt",
          retry_reason: "reconciliation:binding_structurally_corrupt",
          state: "terminal" },
      ]);
      const effects = await database.query<{ count: number; maximum: number }>(
        `SELECT count(*)::integer AS count,
                max(per_question)::integer AS maximum
         FROM (SELECT count(*)::integer AS per_question
               FROM meeting_core.answer_effects GROUP BY effect_id) AS grouped`);
      expect(effects.rows[0]).toEqual({ count: 3, maximum: 1 });
      await restarted.cancelQuestion("33333333333333333");
      const acknowledged = await restarted.listActiveQuestionsForReconciliation({
        afterQuestionId: null, maximumRows: 100 });
      expect(acknowledged.some(({ questionId }) =>
        questionId === "33333333333333333")).toBe(false);
      const deliveredSeen = await restarted.listActiveQuestionsForReconciliation({
        afterQuestionId: rows[349]!.questionId, maximumRows: 100 });
      // Canonically terminal delivered effects are no longer periodic work.
      expect(deliveredSeen.filter(({ questionId }) => deliveredIds.includes(questionId))
        .map(({ questionId }) => questionId)).toEqual([]);
      expect(deliveredSeen).toHaveLength(51);
      expect(durablePages.find(({ questionId }) =>
        questionId === "55555555555555555")).toBeUndefined();
    });
});

function currentBinding(questionId: string) {
  return QuestionBinding.create({
    authorizationDigest: "a".repeat(64),
    authorizationPolicyVersion: questionPolicy.authorizationPolicyVersion,
    authorizationPrincipalRef: "principal:restart",
    botApplicationIdentity: "11111111111111111",
    bindingProtocolVersion: 2,
    canonicalEvidenceHash: "b".repeat(64),
    deliveryContainerId: "22222222222222222",
    expectedLocale: "en",
    finalProjectionEpoch: "projection-epoch-restart",
    finalProjectionReceipt:
      "discord:v2:channel:22222222222222222:message:44444444444444444",
    humanActorIds: ["77777777777777777"],
    meetingId: `meeting-${questionId}`,
    meetingRevision: 1,
    memoryGeneration: `focused-memory:v1:${"b".repeat(64)}`,
    policyVersion: questionPolicy.policyVersion,
    projectionTargetContainerId: "22222222222222222",
    questionHash: "c".repeat(64), questionId,
    requesterSubject: "d".repeat(64),
    retrievalBinding: {
      canonicalEvidenceFilters: { relativeTimeInterval: null,
        requiresSpeakerMatch: false, speakerIds: [] },
      cutoverEpoch: "restart-r1",
      localCurrentIdentity: { algorithmId: "canonical_local_exact_lexical_v1",
        profileFingerprint: "e".repeat(64),
        profileId: "meeting-knowledge.local-current.v2" },
      originalQuestion: "Question?", profileFingerprint: "e".repeat(64),
      provenanceSchemaVersion: 1,
      retrievalPath: "canonical_local_exact_lexical_v1",
    },
    roomId: "room-restart", scopeId: "66666666666666666",
    transcriptId: "transcript-restart", transcriptVersion: 1,
  }).toSnapshot();
}

function flattenPlanNodes(value: unknown): readonly Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {visit(item);}
      return;
    }
    if (typeof candidate !== "object" || candidate === null) {return;}
    const record = candidate as Record<string, unknown>;
    if (typeof record["Node Type"] === "string") {nodes.push(record);}
    for (const nested of Object.values(record)) {visit(nested);}
  };
  visit(value);
  return nodes;
}
