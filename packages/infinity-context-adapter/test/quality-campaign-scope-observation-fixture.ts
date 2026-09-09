import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256 } from "../src/quality-campaign/canonical.js";
import type { AttemptIdentity } from "../src/quality-campaign/execution.js";
import { createProductionCanonicalExecutionEvidence } from
  "../src/quality-campaign/production-canonical-execution-evidence.js";
import { createProductionLocalCanonicalEvidenceReader } from
  "../src/quality-campaign/production-local-canonical-evidence-reader.js";
import type { CanonicalScopeObservationPort } from "../src/quality-campaign/retention.js";

export function scopeObservation(identity: AttemptIdentity) {
  return { schemaVersion: "meeting_knowledge.scope_resolution.v1", status: "prepared",
    reads: ["scope_spaces", "scope_memory_scopes"].map((kind) => ({ kind,
      requestSha256: sha256({ kind, questionId: identity.questionId }), responseSha256: sha256({ kind }),
      responseBytes: 12, status: "received" })) };
}

/** Synthetic metadata is sealed and reopened by the production custody implementation. */
export function scopeObservationCustody(): CanonicalScopeObservationPort {
  const root = mkdtemp(join(tmpdir(), "scope-retention-fixture-"));
  const sealed = new Map<string, Promise<void>>();
  return { readScopeObservation: async (identity) => {
    const directory = await root;
    const input = { artifactKey: new Uint8Array(32).fill(7), artifactKeyId: "scope-fixture",
      artifactRoot: join(directory, "artifacts") };
    if (!sealed.has(identity.attemptId)) {
      sealed.set(identity.attemptId, (async () => {
        const evidence = createProductionCanonicalExecutionEvidence({ ...input,
          answerJournalRoot: join(directory, "answer"), retrievalJournalRoot: join(directory, "retrieval"),
          attemptId: identity.attemptId, questionId: identity.questionId, repetition: identity.repetition,
          rootBindingSha256: identity.campaignRootSha256 });
        await evidence.audit.seal({ attemptId: identity.attemptId, kind: "scope_resolution_observation",
          plaintext: Buffer.from(canonicalJson(scopeObservation(identity))) });
      })());
    }
    await sealed.get(identity.attemptId);
    return await createProductionLocalCanonicalEvidenceReader(input).readScopeObservation(identity);
  } };
}
