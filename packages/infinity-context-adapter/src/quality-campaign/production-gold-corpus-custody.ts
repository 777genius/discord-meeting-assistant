import { canonicalJson, digest, exactRecord } from "./canonical.js";
import { readSignedCorpusDocument } from "./production-execution-corpus-custody.js";
import { validateQualificationGoldPacket, type QualificationGoldPacket } from
  "./qualification-corpus-packets.js";

interface CorpusAuthority { readonly keyId: string; readonly publicKeyPem: string }

/** Scoring-only loader. Production execution composition does not import this module. */
export async function loadProductionGoldCorpusAfterTerminal(input: {
  readonly authority: CorpusAuthority;
  readonly campaignRootSha256: string;
  readonly expectedQuestionIds: readonly string[];
  readonly goldPacketPath: string;
  readonly terminalOutcomeSetSha256: string;
}): Promise<readonly QualificationGoldPacket[]> {
  digest(input.campaignRootSha256, "gold corpus campaign root");
  digest(input.terminalOutcomeSetSha256, "terminal outcome set");
  if (input.expectedQuestionIds.length === 0 ||
    new Set(input.expectedQuestionIds).size !== input.expectedQuestionIds.length) {
    throw new Error("terminal outcome membership is absent or duplicated");
  }
  const signed = await readSignedCorpusDocument(input.goldPacketPath, input.authority,
    "gold corpus");
  const payload = exactRecord(signed.payload, ["campaignRootSha256", "packets",
    "schemaVersion", "terminalOutcomeSetSha256"], "gold corpus payload");
  if (payload.schemaVersion !== "meeting_knowledge.quality_gold_corpus.v1" ||
    payload.campaignRootSha256 !== input.campaignRootSha256 ||
    payload.terminalOutcomeSetSha256 !== input.terminalOutcomeSetSha256 ||
    !Array.isArray(payload.packets)) {
    throw new Error("gold corpus was not admitted after the terminal outcome set");
  }
  const packets = payload.packets.map(validateQualificationGoldPacket);
  if (canonicalJson(packets.map(({ questionId }) => questionId).toSorted()) !==
    canonicalJson([...input.expectedQuestionIds].toSorted())) {
    throw new Error("gold corpus membership differs from terminal outcomes");
  }
  return Object.freeze(packets);
}
