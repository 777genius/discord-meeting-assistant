import { generateKeyPairSync, sign } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256 } from "../src/quality-campaign/canonical.js";
import { loadProductionExecutionCorpus, parseCanonicalQualityCampaignJsonBytes,
  readQualityCampaignBytes } from
  "../src/quality-campaign/production-execution-corpus-custody.js";
import { loadProductionGoldCorpusAfterTerminal } from
  "../src/quality-campaign/production-gold-corpus-custody.js";

describe("production quality corpus custody", () => {
  it("loads an execution-safe packet without accepting or opening a gold path", async () => {
    const fixture = await corpusFixture();
    const packets = await loadProductionExecutionCorpus({ authority: fixture.authority,
      campaignRootSha256: fixture.campaignRootSha256, expectedQuestionCount: 240,
      executionPacketPath: fixture.executionPath });
    expect(packets).toHaveLength(240);
    expect(packets[0]).toEqual({ locale: "en", questionId: "q-1",
      questionText: "What was approved?", scopeTopologyReference: "signed-scope:q-1",
      source: "automatic" });
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

  it("rejects partial completion and an unlisted completed-output entry", async () => {
    const partial = await corpusFixture();
    const partialManifestPath = join(partial.root, "corpus-admission-manifest.json");
    const partialManifest = JSON.parse(await readFile(partialManifestPath, "utf8")) as {
      artifactInventory: unknown[] };
    partialManifest.artifactInventory.pop();
    await writeFile(partialManifestPath, canonicalJson(partialManifest));
    await expect(loadProductionExecutionCorpus({ authority: partial.authority,
      campaignRootSha256: partial.campaignRootSha256, expectedQuestionCount: 240,
      executionPacketPath: partial.executionPath })).rejects.toThrow(/inventory/u);

    const extended = await corpusFixture();
    await writeFile(join(extended.root, "unlisted-after-completion.json"), "{}");
    await expect(loadProductionExecutionCorpus({ authority: extended.authority,
      campaignRootSha256: extended.campaignRootSha256, expectedQuestionCount: 240,
      executionPacketPath: extended.executionPath })).rejects.toThrow(/inventory/u);
  });

  it("reads small files within their bound and rejects files already over it", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-corpus-bounded-read-"));
    const path = join(root, "bounded.txt");
    await writeFile(path, "tiny");
    const allocation = vi.spyOn(Buffer, "allocUnsafe");
    try {
      await expect(readQualityCampaignBytes(path, "bounded fixture", 8_000_000))
        .resolves.toEqual(Buffer.from("tiny"));
      expect(allocation).toHaveBeenCalledWith(5);
    } finally {allocation.mockRestore();}
    await writeFile(path, "12345");
    await expect(readQualityCampaignBytes(path, "bounded fixture", 4))
      .rejects.toThrow(/changed or exceeds its byte limit/u);
  });

  it("rejects deterministic growth after the initial size check", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-corpus-growing-read-"));
    const path = join(root, "growing.txt");
    await writeFile(path, "tiny");
    const allocate = Buffer.allocUnsafe.bind(Buffer);
    const allocation = vi.spyOn(Buffer, "allocUnsafe").mockImplementationOnce((size) => {
      appendFileSync(path, "!");
      return allocate(size);
    });
    try {
      await expect(readQualityCampaignBytes(path, "growing fixture", 8_000_000))
        .rejects.toThrow(/changed or exceeds its byte limit/u);
    } finally {allocation.mockRestore();}
  });

  it("does not allow a caller to reduce the admitted execution cardinality", async () => {
    const fixture = await corpusFixture();
    await expect(loadProductionExecutionCorpus({ authority: fixture.authority,
      campaignRootSha256: fixture.campaignRootSha256, expectedQuestionCount: 1,
      executionPacketPath: fixture.executionPath })).rejects.toThrow(/cardinality/u);
  });

  it("parses the exact bounded bytes even when the pathname is replaced", async () => {
    const fixture = await corpusFixture();
    const snapshot = await readQualityCampaignBytes(fixture.executionPath,
      "execution snapshot", 8_000_000);
    const replacement = `${fixture.executionPath}.replacement`;
    await writeFile(replacement, canonicalJson(fixture.signed({ campaignRootSha256:
      fixture.campaignRootSha256, packets: [], schemaVersion:
      "meeting_knowledge.quality_execution_corpus.v1" })));
    await rename(replacement, fixture.executionPath);
    const parsed = parseCanonicalQualityCampaignJsonBytes(snapshot, "execution snapshot") as {
      payload: { packets: unknown[] } };
    expect(parsed.payload.packets).toHaveLength(240);
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
  const executionPath = join(root, "execution-corpus.json");
  const packets = Array.from({ length: 240 }, (_, index) => ({
    locale: index % 2 === 0 ? "en" : "ru", questionId: `q-${index + 1}`,
    questionText: index === 0 ? "What was approved?" : `Synthetic question ${index + 1}?`,
    scopeTopologyReference: `signed-scope:q-${index + 1}`,
    source: index < 200 ? "automatic" : "independent_review" }));
  await writeFile(executionPath, canonicalJson(signed({ campaignRootSha256, packets,
  schemaVersion: "meeting_knowledge.quality_execution_corpus.v1" })));
  const goldPath = join(root, "gold-relevance.json");
  await writeFile(goldPath, canonicalJson(signed({ campaignRootSha256, packets: [{
    abstentionAuthority: "answerable", evidenceLocators: ["locator-1"],
    expectedClaims: ["approved"], forbiddenClaims: ["rejected"], questionId: "q-1",
    speakerTimeAuthority: [{ endMs: 20, speakerId: "speaker-1", startMs: 10 }] }],
  schemaVersion: "meeting_knowledge.quality_gold_corpus.v1", terminalOutcomeSetSha256 })));
  const canonicalNames = ["InputManifest.v4.json", "acceptance-receipt.json",
    "automatic-questions.json", "execution-authorization.json", "execution-corpus.json",
    "forbidden-locator-manifest.json", "forbidden-locators.json", "gold-relevance.json",
    "independent-review-questions.json", "locator-inventory.json", "question-review-1.json",
    "question-review-2.json", "turn-to-block-manifest.json"];
  for (const artifactName of canonicalNames.filter((name) => name !== "execution-corpus.json" &&
    name !== "gold-relevance.json")) {
    await writeFile(join(root, artifactName), canonicalJson({ name: artifactName }));
  }
  const artifactInventory = await Promise.all(canonicalNames.map(async (name) => ({ path: name,
    sha256: sha256(await readFile(join(root, name))) })));
  await writeFile(join(root, "corpus-admission-manifest.json"), canonicalJson({ artifactInventory,
    authorizationComparisonEpochMs: 1, campaignRootSha256, completionState: "complete",
    corpusDigestSha256: sha256("corpus"), questionCount: 240,
    questionSetSha256: sha256("questions"),
    releaseRootSha256: sha256("release"), schemaVersion:
      "meeting_knowledge.semantic_quality_corpus_admission_manifest.v1" }));
  return { authority, campaignRootSha256, executionPath, goldPath, root, signed,
    terminalOutcomeSetSha256 };
}
