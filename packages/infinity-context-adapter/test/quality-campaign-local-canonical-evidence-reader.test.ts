import { createHash } from "node:crypto";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/quality-campaign/canonical.js";
import { createProductionCanonicalExecutionEvidence } from
  "../src/quality-campaign/production-canonical-execution-evidence.js";
import { createProductionLocalCanonicalEvidenceReader } from
  "../src/quality-campaign/production-local-canonical-evidence-reader.js";

const attemptId = `sqv4-${"a".repeat(64)}`;
const campaignRootSha256 = "b".repeat(64);

describe("production local canonical evidence reader", () => {
  it("authenticates the exact SDK exchange and normalized outcome into a deterministic inventory",
    async () => {
      const fixture = await localFixture();
      const verified = await fixture.reader.verify({ attempts: [fixture.projection],
        campaignRootSha256 });
      expect(verified.inventorySha256).toMatch(/^[a-f0-9]{64}$/u);
      await expect(fixture.reader.verify({ attempts: [{ ...fixture.projection,
        retrievalLatencyUs: fixture.projection.retrievalLatencyUs - 1 }], campaignRootSha256 }))
        .rejects.toThrow("differs from measured canonical SDK operation");
      const foreignKeyReader = createProductionLocalCanonicalEvidenceReader({ artifactKey:
        new Uint8Array(32).fill(7), artifactKeyId: "another-key", artifactRoot:
        fixture.artifactRoot });
      await expect(foreignKeyReader.verify({ attempts: [fixture.projection], campaignRootSha256 }))
        .rejects.toThrow("key identity differs");
    });

  it("fails closed for an extra observation key and a mismatched receipt byte size", async () => {
    const extra = await localFixture({ extraObservationKey: true });
    await expect(extra.reader.verify({ attempts: [extra.projection], campaignRootSha256 }))
      .rejects.toThrow("canonical retrieval observation has an invalid shape");

    const fixture = await localFixture();
    const path = join(fixture.artifactRoot, "receipts", attemptId, "retrieval_response.json");
    const receipt = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, canonicalJson({ ...receipt, sizeBytes: Number(receipt.sizeBytes) + 1 }),
      { mode: 0o600 });
    await expect(fixture.reader.verify({ attempts: [fixture.projection], campaignRootSha256 }))
      .rejects.toThrow("size or envelope digest differs");
  });

  it("rejects outcome and attempt projections that do not match retained local bytes", async () => {
    const fixture = await localFixture();
    await expect(fixture.reader.verify({ attempts: [{ ...fixture.projection,
      rankedLocatorIds: ["another-locator"] }], campaignRootSha256 }))
      .rejects.toThrow("locators or turns differ");
    await expect(fixture.reader.verify({ attempts: [{ ...fixture.projection,
      retrievalResponseSha256: "c".repeat(64) }], campaignRootSha256 }))
      .rejects.toThrow("differs from external terminal evidence");
    await expect(fixture.reader.verify({ attempts: [{ ...fixture.projection,
      answerAbstained: true }], campaignRootSha256 }))
      .rejects.toThrow("differs from external outcome evidence");
    await expect(fixture.reader.verify({ attempts: [{ ...fixture.projection,
      attemptId: `sqv4-${"d".repeat(64)}` }], campaignRootSha256 })).rejects.toThrow();
    const failed = await localFixture({ outcomeStatus: "failed" });
    await expect(failed.reader.verify({ attempts: [failed.projection], campaignRootSha256 }))
      .rejects.toThrow("differs from external outcome evidence");
  });

  it("rejects missing indices and corrupt envelopes without scanning for replacements", async () => {
    const missing = await localFixture();
    await unlink(join(missing.artifactRoot, "receipts", attemptId, "capability_response.json"));
    await expect(missing.reader.verify({ attempts: [missing.projection], campaignRootSha256 }))
      .rejects.toThrow();

    const corrupt = await localFixture();
    const receipt = JSON.parse(await readFile(join(corrupt.artifactRoot, "receipts", attemptId,
      "retrieval_request.json"), "utf8")) as { envelopeSha256: string };
    await writeFile(join(corrupt.artifactRoot, `${receipt.envelopeSha256}.enc.json`), "corrupt",
      { mode: 0o600 });
    await expect(corrupt.reader.verify({ attempts: [corrupt.projection], campaignRootSha256 }))
      .rejects.toThrow();

    const foreignKind = await localFixture();
    const indexPath = join(foreignKind.artifactRoot, "receipts", attemptId,
      "retrieval_response.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
    await writeFile(indexPath, canonicalJson({ ...index, artifactKind: "retrieval_request" }),
      { mode: 0o600 });
    await expect(foreignKind.reader.verify({ attempts: [foreignKind.projection],
      campaignRootSha256 })).rejects.toThrow("foreign or substituted");
  });
});

async function localFixture(options: { readonly extraObservationKey?: boolean;
  readonly outcomeStatus?: "answered" | "failed" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "canonical-local-reader-"));
  const artifactRoot = join(root, "artifacts"); const artifactKey = new Uint8Array(32).fill(7);
  const evidence = createProductionCanonicalExecutionEvidence({ answerJournalRoot:
    join(root, "answer"), artifactKey, artifactKeyId: "synthetic-key", artifactRoot, attemptId,
  questionId: "q-1", repetition: 1, retrievalJournalRoot: join(root, "retrieval"),
  rootBindingSha256: campaignRootSha256 });
  const capabilityRequest = new Uint8Array();
  const capabilityResponse = bytes(canonicalJson({ capability: "synthetic" }));
  const retrievalRequest = bytes(canonicalJson({ query: "synthetic" }));
  const retrievalResponse = bytes(canonicalJson({ locators: ["locator-1"] }));
  const observation = { attemptId, capabilityAndRetrievalLatencyUs: 12,
    capabilityBytes: capabilityResponse.byteLength, capabilitySha256: sha(capabilityResponse),
    requestBytes: retrievalRequest.byteLength, requestSha256: sha(retrievalRequest),
    responseBytes: retrievalResponse.byteLength, responseSha256: sha(retrievalResponse),
    routeLatencyUs: 7,
    schemaVersion: "meeting_knowledge.canonical_retrieval_observation.v1",
    ...(options.extraObservationKey === true ? { unexpected: true } : {}) };
  const turn = { endMs: 2, sourceLocatorId: "locator-1", speakerId: "speaker-1", startMs: 1,
    text: "Synthetic evidence", turnHash: "turn-hash", turnId: "turn-1" };
  const outcome = { citations: ["turn-1"], claims: ["Synthetic claim"],
    rawRetrievalResponseSha256: sha(retrievalResponse), retrievalCandidates: [{ contributions: [],
      fusedScore: 1, locatorId: "locator-1", providerRank: 0 }], selectedTurns: [turn],
    ...(options.outcomeStatus === "failed" ? { reason: "synthetic_failure" } : {}),
    status: options.outcomeStatus ?? "answered" };
  for (const [kind, plaintext] of [["capability_request", capabilityRequest],
    ["capability_response", capabilityResponse], ["retrieval_request", retrievalRequest],
    ["retrieval_response", retrievalResponse], ["retrieval_observation", bytes(canonicalJson(observation))],
    ["answer_normalized_outcome", bytes(JSON.stringify(outcome))]] as const) {
    await evidence.audit.seal({ attemptId, kind, plaintext });
  }
  return { artifactRoot, reader: createProductionLocalCanonicalEvidenceReader({ artifactKey,
    artifactKeyId: "synthetic-key", artifactRoot }), projection: { answerAbstained: false,
    attemptId, campaignRootSha256,
    capabilityRequestSha256: sha(capabilityRequest), capabilityResponseSha256: sha(capabilityResponse),
    citationLocatorIds: ["locator-1"], evidenceLocatorIds: ["locator-1"],
    evidenceTurnIds: ["turn-1"], rankedLocatorIds: ["locator-1"], retrievalLatencyUs: 12,
    retrievalRequestSha256: sha(retrievalRequest), retrievalResponseSha256:
      sha(retrievalResponse) } };
}
function bytes(value: string): Uint8Array {return new TextEncoder().encode(value);}
function sha(value: Uint8Array): string {return createHash("sha256").update(value).digest("hex");}
