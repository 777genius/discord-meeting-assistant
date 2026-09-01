import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../src/quality-campaign/canonical.js";
import { loadProductionExecutionCorpus } from
  "../src/quality-campaign/production-execution-corpus-custody.js";
import { loadProductionGoldCorpusAfterTerminal } from
  "../src/quality-campaign/production-gold-corpus-custody.js";

describe("production quality corpus custody", () => {
  it("loads an execution-safe packet without accepting or opening a gold path", async () => {
    const fixture = await corpusFixture();
    const packets = await loadProductionExecutionCorpus({ authority: fixture.authority,
      campaignRootSha256: fixture.campaignRootSha256, expectedQuestionCount: 1,
      executionPacketPath: fixture.executionPath });
    expect(packets).toEqual([{ locale: "en", questionId: "q-1",
      questionText: "What was approved?", scopeTopologyReference: "signed-scope:q-1",
      source: "independent_review" }]);
    expect(loadProductionExecutionCorpus.toString()).not.toMatch(/gold/iu);
  });

  it("admits gold only when it is bound to an existing terminal outcome set", async () => {
    const fixture = await corpusFixture();
    await expect(loadProductionGoldCorpusAfterTerminal({ authority: fixture.authority,
      campaignRootSha256: fixture.campaignRootSha256, expectedQuestionIds: ["q-1"],
      goldPacketPath: fixture.goldPath, terminalOutcomeSetSha256: "f".repeat(64) }))
      .rejects.toThrow("after the terminal outcome set");
    await expect(loadProductionGoldCorpusAfterTerminal({ authority: fixture.authority,
      campaignRootSha256: fixture.campaignRootSha256, expectedQuestionIds: ["q-1"],
      goldPacketPath: fixture.goldPath,
      terminalOutcomeSetSha256: fixture.terminalOutcomeSetSha256 }))
      .resolves.toEqual([expect.objectContaining({ abstentionAuthority: "answerable",
        evidenceLocators: ["locator-1"], questionId: "q-1" })]);
  });
});

async function corpusFixture() {
  const root = await mkdtemp(join(tmpdir(), "quality-corpus-custody-"));
  const pair = generateKeyPairSync("ed25519");
  const authority = { keyId: "corpus-custody", publicKeyPem:
    pair.publicKey.export({ format: "pem", type: "spki" }).toString() };
  const campaignRootSha256 = sha256("campaign");
  const terminalOutcomeSetSha256 = sha256("terminals");
  const signed = (payload: unknown) => ({ payload, signatureBase64:
    sign(null, Buffer.from(canonicalJson(payload)), pair.privateKey).toString("base64"),
  signerKeyId: authority.keyId });
  const executionPath = join(root, "execution.json");
  await writeFile(executionPath, canonicalJson(signed({ campaignRootSha256, packets: [{
    locale: "en", questionId: "q-1", questionText: "What was approved?",
    scopeTopologyReference: "signed-scope:q-1", source: "independent_review" }],
  schemaVersion: "meeting_knowledge.quality_execution_corpus.v1" })));
  const goldPath = join(root, "gold.json");
  await writeFile(goldPath, canonicalJson(signed({ campaignRootSha256, packets: [{
    abstentionAuthority: "answerable", evidenceLocators: ["locator-1"],
    expectedClaims: ["approved"], forbiddenClaims: ["rejected"], questionId: "q-1",
    speakerTimeAuthority: [{ endMs: 20, speakerId: "speaker-1", startMs: 10 }] }],
  schemaVersion: "meeting_knowledge.quality_gold_corpus.v1", terminalOutcomeSetSha256 })));
  return { authority, campaignRootSha256, executionPath, goldPath, terminalOutcomeSetSha256 };
}
