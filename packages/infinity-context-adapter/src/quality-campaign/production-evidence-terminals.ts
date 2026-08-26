import type { CampaignQuestion } from "./campaign-contracts.js";
import { digest, exactRecord, sha256 } from "./canonical.js";
import { attemptIdentity, verifyExternalSignedValue, type ProviderTerminalPayload } from
  "./execution.js";
import type { ExactOutcomeEvidence, ExactTerminalEvidence } from "./production-evidence.js";

function terminalPayloadMatches(payload: ProviderTerminalPayload, input: { readonly identity:
  ReturnType<typeof attemptIdentity>; readonly callKind: "answer" | "capability" | "retrieval";
  readonly ordinal: number; readonly outcome: ExactOutcomeEvidence;
  readonly predecessor: string | null; readonly question: CampaignQuestion;
  readonly releaseRootSha256: string; readonly root: string; readonly spendReservationSha256: string;
  readonly terminal: ExactTerminalEvidence }): boolean {
  return payload.attemptId === input.identity.attemptId && payload.callKind === input.callKind &&
    payload.callOrdinal === input.ordinal && payload.campaignRootSha256 === input.root &&
    payload.predecessorResultDigestSha256 === input.predecessor && payload.questionDigestSha256 ===
    input.question.questionDigestSha256 && payload.questionId === input.question.questionId &&
    payload.releaseRootSha256 === input.releaseRootSha256 && payload.repetition ===
    input.outcome.repetition && payload.requestDigestSha256 === input.terminal.requestDigestSha256 &&
    payload.resultEnvelopeDigestSha256 === input.terminal.resultEnvelopeDigestSha256 &&
    payload.spendReservationSha256 === input.spendReservationSha256 &&
    payload.state === "terminal_success";
}

export function assertTerminalChain(input: { readonly authority: { readonly keyId: string;
  readonly publicKeyPem: string }; readonly outcome: ExactOutcomeEvidence;
  readonly question: CampaignQuestion; readonly releaseRootSha256: string; readonly root: string;
  readonly spendReservationSha256: string }): void {
  const { authority, outcome, question, releaseRootSha256, root, spendReservationSha256 } = input;
  const terminalChain: unknown = outcome.terminalChain;
  if (!Array.isArray(terminalChain) || terminalChain.length !== 3) {
    throw new Error("provider terminal chain is incomplete");
  }
  let predecessor: string | null = null;
  for (const [ordinal, callKind] of (["capability", "retrieval", "answer"] as const).entries()) {
    const terminal = exactRecord(terminalChain[ordinal], ["attemptId", "callKind", "callOrdinal",
      "predecessorResultDigestSha256", "requestDigestSha256", "resultEnvelopeDigestSha256",
      "signedResult", "terminalDigestSha256"], "outcome terminal chain") as unknown as
      ExactTerminalEvidence;
    const identity = attemptIdentity({ callKind, callOrdinal: ordinal, campaignRootSha256: root,
      questionDigestSha256: question.questionDigestSha256, questionId: question.questionId,
      repetition: outcome.repetition });
    if (terminal.attemptId !== identity.attemptId || terminal.callKind !== callKind ||
      terminal.callOrdinal !== ordinal || terminal.predecessorResultDigestSha256 !== predecessor) {
      throw new Error("capability, retrieval, and answer terminals are not exactly chained");
    }
    for (const terminalDigest of [terminal.requestDigestSha256,
      terminal.resultEnvelopeDigestSha256, terminal.terminalDigestSha256]) {
      digest(terminalDigest, "outcome terminal");
    }
    const signed = verifyExternalSignedValue<ProviderTerminalPayload>(terminal.signedResult,
      authority.keyId, authority.publicKeyPem, "evidence provider terminal");
    if (!terminalPayloadMatches(signed.payload, { identity, callKind, ordinal, outcome, predecessor,
      question, releaseRootSha256, root, spendReservationSha256, terminal }) ||
      terminal.terminalDigestSha256 !== sha256(signed)) {
      throw new Error("provider terminal signature is foreign to request, result, release, spend, or call");
    }
    predecessor = terminal.resultEnvelopeDigestSha256;
  }
  if (outcome.attemptId !== outcome.terminalChain[2].attemptId) {
    throw new Error("answer outcome is not bound to its provider terminal");
  }
}
