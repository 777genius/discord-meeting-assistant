import { SemanticQualityV4CreateOnlyJournal, SemanticQualityV4EncryptedArtifactStore,
  semanticQualityV4AttemptId, type SemanticQualityV4ArtifactKind } from
  "./canonical-execution-evidence-store.js";
import type { QualificationCreateOnlyJournalPort, QualificationEncryptedAuditPort } from
  "./production-canonical-question-chain.js";

/** Durable adapters shared by the scheduler and the one canonical execution chain. */
export function createProductionCanonicalExecutionEvidence(input: {
  readonly answerJournalRoot: string;
  readonly artifactKey: Uint8Array;
  readonly artifactKeyId: string;
  readonly artifactRoot: string;
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3;
  readonly retrievalJournalRoot: string;
  readonly rootBindingSha256: string;
}): { readonly audit: QualificationEncryptedAuditPort;
  readonly journal: QualificationCreateOnlyJournalPort } {
  const journals = Object.freeze({
    answer: new SemanticQualityV4CreateOnlyJournal(input.answerJournalRoot),
    retrieval: new SemanticQualityV4CreateOnlyJournal(input.retrievalJournalRoot),
  });
  const expectedAttemptId = semanticQualityV4AttemptId({ questionId: input.questionId,
    repetition: input.repetition, rootBindingSha256: input.rootBindingSha256 });
  const reserved = new Map<"answer" | "retrieval", string>();
  const artifacts = new SemanticQualityV4EncryptedArtifactStore(input.artifactRoot);
  const journal: QualificationCreateOnlyJournalPort = Object.freeze({
    reserve: async ({ attemptId, payloadSha256, phase }) => {
      if (attemptId !== expectedAttemptId ||
        await journals[phase].state({ questionId: input.questionId,
          repetition: input.repetition, rootBindingSha256: input.rootBindingSha256 }) !==
          "never_reserved") {
        throw new Error("canonical provider effect is already reserved and cannot be retried");
      }
      await journals[phase].reserve({ questionId: input.questionId,
        repetition: input.repetition, reservedPayloadSha256: payloadSha256,
        rootBindingSha256: input.rootBindingSha256 });
      reserved.set(phase, payloadSha256);
    },
    terminal: async ({ attemptId, payloadSha256, phase, state }) => {
      const reservedPayloadSha256 = reserved.get(phase);
      if (attemptId !== expectedAttemptId || reservedPayloadSha256 === undefined) {
        throw new Error("canonical provider terminal lacks the durable reservation");
      }
      await journals[phase].terminal({ questionId: input.questionId,
        repetition: input.repetition, reservedPayloadSha256,
        rootBindingSha256: input.rootBindingSha256, state,
        terminalPayloadSha256: payloadSha256 });
      reserved.delete(phase);
    },
  });
  const audit: QualificationEncryptedAuditPort = Object.freeze({
    seal: async ({ attemptId, kind, plaintext }) => {
      if (attemptId !== expectedAttemptId) {
        throw new Error("canonical encrypted evidence attempt is substituted");
      }
      await artifacts.sealCreateOnly({ artifactKind: kind as SemanticQualityV4ArtifactKind,
        attemptId, key: input.artifactKey, keyId: input.artifactKeyId, plaintext,
        rootBindingSha256: input.rootBindingSha256 });
    },
  });
  return Object.freeze({ audit, journal });
}
