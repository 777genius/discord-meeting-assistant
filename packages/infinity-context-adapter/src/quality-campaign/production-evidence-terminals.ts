import type { CampaignQuestion } from "./admission.js";
import { digest, exactRecord, sha256 } from "./canonical.js";
import { attemptIdentity, verifyExternalSignedValue } from
  "./execution.js";
import type { ExactOutcomeEvidence, ExactTerminalEvidence } from "./production-evidence.js";
import { assertQualificationProviderAccounting,
  type QualificationProviderAccounting } from "./qualification-contract.js";
import type { QualityCampaignRelease } from "./release.js";

interface EvidenceProviderTerminalPayload {
  readonly attemptId: string; readonly callKind: "answer" | "capability" | "retrieval";
  readonly callOrdinal: number; readonly campaignRootSha256: string;
  readonly providerAccounting: QualificationProviderAccounting;
  readonly questionDigestSha256: string;
  readonly questionId: string; readonly releaseRootSha256: string; readonly repetition: 1 | 2 | 3;
  readonly requestDigestSha256: string; readonly resultDigestSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4";
  readonly spendReservationSha256: string; readonly state: "terminal_success";
}

function terminalPayloadMatches(payload: EvidenceProviderTerminalPayload, input: { readonly identity:
  ReturnType<typeof attemptIdentity>; readonly callKind: "answer" | "capability" | "retrieval";
  readonly callOrdinal: number; readonly outcome: ExactOutcomeEvidence;
  readonly predecessor: string | null; readonly question: CampaignQuestion;
  readonly releaseRootSha256: string; readonly root: string; readonly spendReservationSha256: string;
  readonly terminal: ExactTerminalEvidence }): boolean {
  return payload.attemptId === input.identity.attemptId && payload.callKind === input.callKind &&
    payload.callOrdinal === input.callOrdinal && payload.campaignRootSha256 === input.root &&
    payload.questionDigestSha256 === input.question.questionDigestSha256 &&
    payload.questionId === input.question.questionId &&
    payload.releaseRootSha256 === input.releaseRootSha256 && payload.repetition ===
    input.outcome.repetition && payload.requestDigestSha256 === input.terminal.requestDigestSha256 &&
    payload.resultDigestSha256 === input.terminal.resultEnvelopeDigestSha256 &&
    payload.spendReservationSha256 === input.spendReservationSha256 &&
    payload.schemaVersion === "meeting_knowledge.semantic_quality_provider_terminal_payload.v4" &&
    payload.state === "terminal_success";
}

export function assertTerminalChain(input: { readonly authority: { readonly keyId: string;
  readonly publicKeyPem: string }; readonly outcome: ExactOutcomeEvidence;
  readonly question: CampaignQuestion; readonly releaseRootSha256: string; readonly root: string;
  readonly release: QualityCampaignRelease;
  readonly spendReservationSha256: string }): void {
  const { authority, outcome, question, releaseRootSha256, root, spendReservationSha256 } = input;
  const terminalChain: unknown = outcome.terminalChain;
  if (!Array.isArray(terminalChain) || terminalChain.length !== 3) {
    throw new Error("provider terminal chain is incomplete");
  }
  let predecessor: string | null = null;
  for (const [position, callKind] of (["capability", "retrieval", "answer"] as const).entries()) {
    const terminal = exactRecord(terminalChain[position], ["attemptId", "callKind", "callOrdinal",
      "predecessorResultDigestSha256", "requestDigestSha256", "resultEnvelopeDigestSha256",
      "signedResult", "terminalDigestSha256"], "outcome terminal chain") as unknown as
      ExactTerminalEvidence;
    const identity = attemptIdentity({ callKind, callOrdinal: 0, campaignRootSha256: root,
      questionDigestSha256: question.questionDigestSha256, questionId: question.questionId,
      releaseRootSha256, repetition: outcome.repetition, spendReservationSha256 });
    if (terminal.attemptId !== identity.attemptId || terminal.callKind !== callKind ||
      terminal.callOrdinal !== 0 || terminal.predecessorResultDigestSha256 !== predecessor) {
      throw new Error("capability, retrieval, and answer terminals are not exactly chained");
    }
    for (const terminalDigest of [terminal.requestDigestSha256,
      terminal.resultEnvelopeDigestSha256, terminal.terminalDigestSha256]) {
      digest(terminalDigest, "outcome terminal");
    }
    const signed = verifyExternalSignedValue<unknown>(terminal.signedResult,
      authority.keyId, authority.publicKeyPem, "evidence provider terminal");
    const payload = decodeProviderTerminalPayload(signed.payload);
    assertQualificationProviderAccounting(payload.providerAccounting,
      { callKind, release: input.release });
    if (!terminalPayloadMatches(payload, { identity, callKind, callOrdinal: 0, outcome, predecessor,
      question, releaseRootSha256, root, spendReservationSha256, terminal }) ||
      terminal.terminalDigestSha256 !== sha256(signed)) {
      throw new Error("provider terminal signature is foreign to request, result, release, spend, or call");
    }
    predecessor = terminal.resultEnvelopeDigestSha256;
  }
  if (outcome.attemptId !== outcome.terminalChain[2]!.attemptId) {
    throw new Error("answer outcome is not bound to its provider terminal");
  }
}

function decodeProviderTerminalPayload(value: unknown): EvidenceProviderTerminalPayload {
  return exactRecord(value, ["attemptId", "callKind", "callOrdinal", "campaignRootSha256",
    "providerAccounting", "questionDigestSha256", "questionId", "releaseRootSha256", "repetition",
    "requestDigestSha256", "resultDigestSha256", "schemaVersion", "spendReservationSha256",
    "state"], "evidence provider terminal payload") as unknown as
    EvidenceProviderTerminalPayload;
}
