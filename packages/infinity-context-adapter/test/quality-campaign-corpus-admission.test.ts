import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, publicKeyFingerprintSha256, sha256 } from
  "../src/quality-campaign/canonical.js";
import { runQualityCampaignProductionCli } from "../src/quality-campaign/production-cli.js";
import { loadProductionExecutionCorpus } from
  "../src/quality-campaign/production-execution-corpus-custody.js";
import { QUALITY_AUTHORITY_ROLES } from "../src/quality-campaign/release.js";

describe("installed quality campaign corpus admission", () => {
  it("deterministically emits execution-safe and role-separated production inputs", async () => {
    const fixture = await createFixture();
    const statusPath = join(fixture.root, "status.json");
    await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
      statusPath] })).resolves.toBe(0);

    const status = await json(statusPath) as { digests: { campaignRootSha256: string } };
    const executionPath = join(fixture.outputRoot, "execution-corpus.json");
    const packets = await loadProductionExecutionCorpus({ authority: fixture.custodyAuthority,
      campaignRootSha256: status.digests.campaignRootSha256, expectedQuestionCount: 240,
      executionPacketPath: executionPath });
    expect(packets).toHaveLength(240);
    expect(packets.filter(({ source }) => source === "automatic")).toHaveLength(200);
    expect(packets.filter(({ source }) => source === "independent_review")).toHaveLength(40);
    expect(new Set(packets.map(({ locale }) => locale))).toEqual(new Set(["en", "ru", "mixed"]));
    const executionBytes = await readFile(executionPath, "utf8");
    expect(executionBytes).not.toContain("expectedClaims");
    expect(executionBytes).not.toContain("evidenceLocators");
    expect(executionBytes).not.toContain("abstentionAuthority");

    const gold = await json(join(fixture.outputRoot, "gold-relevance.json")) as {
      signerKeyId: string; payload: { entries: unknown[] } };
    expect(gold.signerKeyId).toBe(fixture.keyIds.gold_relevance);
    expect(gold.signerKeyId).not.toBe(fixture.custodyAuthority.keyId);
    expect(gold.payload.entries).toHaveLength(240);
    const first = await artifactBytes(fixture.outputRoot);

    const secondOutputRoot = join(fixture.root, "prepared-second");
    const secondPhase = await json(fixture.phasePath) as { payload: Record<string, unknown>;
      schemaVersion: string };
    secondPhase.payload.outputRoot = secondOutputRoot;
    const secondPhasePath = join(fixture.root, "phase-second.json");
    await writeFile(secondPhasePath, canonicalJson(secondPhase));
    await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", secondPhasePath,
      join(fixture.root, "status-second.json")] })).resolves.toBe(0);
    expect(await artifactBytes(secondOutputRoot)).toEqual(first);
  });

  it("fails closed for tampering, wrong counts, cross-scope bindings, and path substitution",
    async () => {
      for (const mutation of ["tamper", "hash", "unsigned", "count", "duplicate", "version",
        "scope", "path", "auth-version", "auth-disabled", "auth-expired", "symlink",
        "duplicate-json"] as const) {
        const fixture = await createFixture();
        const phase = await json(fixture.phasePath) as { payload: Record<string, unknown>;
          schemaVersion: string };
        if (mutation === "tamper") {
          const review = await json(String(Array.isArray(phase.payload.questionReviewReceiptPaths) &&
            phase.payload.questionReviewReceiptPaths[0])) as { payload: Record<string, unknown> };
          review.payload.questionSetSha256 = "0".repeat(64);
          await writeFile((phase.payload.questionReviewReceiptPaths as string[])[0]!,
            canonicalJson(review));
        } else if (mutation === "hash") {
          const corpus = await json(String(phase.payload.sealedCorpusPath)) as {
            entries: { execution: { questionText: string } }[] };
          corpus.entries[0]!.execution.questionText = "Changed after signed custody.";
          await writeFile(String(phase.payload.sealedCorpusPath), canonicalJson(corpus));
        } else if (mutation === "unsigned") {
          const receiptPath = (phase.payload.questionReviewReceiptPaths as string[])[0]!;
          const review = await json(receiptPath) as Record<string, unknown>;
          delete review.signatureBase64;
          await writeFile(receiptPath, canonicalJson(review));
        } else if (mutation === "count") {
          const corpus = await json(String(phase.payload.sealedCorpusPath)) as { entries: unknown[] };
          corpus.entries.pop();
          await writeFile(String(phase.payload.sealedCorpusPath), canonicalJson(corpus));
        } else if (mutation === "duplicate") {
          const corpus = await json(String(phase.payload.sealedCorpusPath)) as {
            entries: { execution: { questionId: string }; gold: { questionId: string } }[] };
          corpus.entries[1]!.execution.questionId = corpus.entries[0]!.execution.questionId;
          corpus.entries[1]!.gold.questionId = corpus.entries[0]!.gold.questionId;
          await writeFile(String(phase.payload.sealedCorpusPath), canonicalJson(corpus));
        } else if (mutation === "version") {
          const corpus = await json(String(phase.payload.sealedCorpusPath)) as {
            schemaVersion: string };
          corpus.schemaVersion = "meeting_knowledge.semantic_quality_sealed_corpus.v2";
          await writeFile(String(phase.payload.sealedCorpusPath), canonicalJson(corpus));
        } else if (mutation === "scope") {
          const corpus = await json(String(phase.payload.sealedCorpusPath)) as {
            releaseRootSha256: string };
          corpus.releaseRootSha256 = "0".repeat(64);
          await writeFile(String(phase.payload.sealedCorpusPath), canonicalJson(corpus));
        } else if (mutation === "path") {
          phase.payload.outputRoot = join(fixture.root, "inputs");
          await writeFile(fixture.phasePath, canonicalJson(phase));
        } else if (mutation.startsWith("auth-")) {
          const authorizationPath = String(phase.payload.executionAuthorizationPath);
          const authorization = await json(authorizationPath) as { payload: Record<string, unknown> };
          if (mutation === "auth-version") {
            authorization.payload.schemaVersion =
              "meeting_knowledge.semantic_quality_execution_authorization.v2";
          } else if (mutation === "auth-disabled") {
            authorization.payload.authorizedProviderExecution = false;
          } else {
            authorization.payload.expiresAtEpochMs = 1_000_000;
          }
          await writeFile(authorizationPath, canonicalJson(fixture.signCustody(
            authorization.payload)));
        } else if (mutation === "symlink") {
          const corpusPath = String(phase.payload.sealedCorpusPath);
          const targetPath = `${corpusPath}.target`;
          await rename(corpusPath, targetPath);
          await symlink(targetPath, corpusPath);
        } else {
          const corpusPath = String(phase.payload.sealedCorpusPath);
          const bytes = await readFile(corpusPath, "utf8");
          await writeFile(corpusPath,
            `{"schemaVersion":"meeting_knowledge.semantic_quality_sealed_corpus.v1",${bytes.slice(1)}`);
        }
        await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
          join(fixture.root, `status-${mutation}.json`)] })).resolves.toBe(1);
      }
    });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "quality-corpus-admission-test-"));
  const inputRoot = join(root, "inputs");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(inputRoot));
  const authorities: Record<string, Awaited<ReturnType<typeof authority>>> = {};
  for (const role of QUALITY_AUTHORITY_ROLES) {authorities[role] = await authority(inputRoot, role);}
  const policyPath = join(inputRoot, "policy.json");
  await writeFile(policyPath, canonicalJson(Object.fromEntries(QUALITY_AUTHORITY_ROLES.map((role) =>
    [role, authorities[role]!.authorityPath]))));
  const releaseRootSha256 = sha256("release");
  const reviewerDigestSha256 = sha256("two-independent-reviewers");
  const snapshotSha256 = sha256("frozen-synthetic-snapshot");
  const sourceDigestSha256 = sha256("synthetic-source");
  const entries = Array.from({ length: 240 }, (_, index) => {
    const questionId = `synthetic-${index.toString().padStart(3, "0")}`;
    const answerable = index % 5 !== 0;
    const locale = (["en", "ru", "mixed"] as const)[index % 3]!;
    const execution = { locale, questionId,
      questionText: locale === "ru" ? `Что решили для ${questionId}?` :
        locale === "mixed" ? `What решили for ${questionId}?` : `What was decided for ${questionId}?`,
      scopeTopologyReference: `signed-scope:${questionId}`,
      source: index < 200 ? "automatic" as const : "independent_review" as const };
    const gold = { abstentionAuthority: answerable ? "answerable" as const :
      "must_abstain" as const, evidenceLocators: answerable ? [sha256(`locator:${index}`)] : [],
      expectedClaims: answerable ? [`claim-${index}`] : [], forbiddenClaims: [], questionId,
      speakerTimeAuthority: answerable ? [{ endMs: index * 100 + 50, speakerId: "speaker-1",
        startMs: index * 100 }] : [] };
    return { execution, forbiddenLocatorIds: [sha256(`forbidden:${index}`)], gold };
  });
  const corpus = { entries, releaseRootSha256, reviewerDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_sealed_corpus.v1",
    snapshotSha256, sourceDigestSha256 };
  const sealedCorpusPath = join(inputRoot, "sealed-corpus.json");
  await writeFile(sealedCorpusPath, canonicalJson(corpus));
  const questions = entries.map(({ execution, gold }) => ({ locale: execution.locale,
    questionDigestSha256: sha256(execution), questionId: execution.questionId,
    rubricDigestSha256: sha256(gold), source: execution.source }));
  const custody = authorities.artifact_custody!;
  const corpusDigestSha256 = sha256(corpus);
  const acceptance = custody.signed({ corpusDigestSha256, purpose: "custody_only",
    reviewerDigestSha256, schemaVersion: "meeting_knowledge.semantic_quality_acceptance.v1",
    sourceDigestSha256 });
  const acceptancePath = join(inputRoot, "acceptance.json");
  await writeFile(acceptancePath, canonicalJson(acceptance));
  const authorization = custody.signed({ acceptanceReceiptSha256: sha256(acceptance),
    authorizedProviderExecution: true, corpusDigestSha256, expiresAtEpochMs: 2_000_000,
    releaseRootSha256, schemaVersion:
      "meeting_knowledge.semantic_quality_execution_authorization.v1" });
  const authorizationPath = join(inputRoot, "authorization.json");
  await writeFile(authorizationPath, canonicalJson(authorization));
  const reviewPayload = { corpusDigestSha256, questionSetSha256: sha256(questions),
    reviewerDigestSha256, rubricSetSha256: sha256(questions.map(({ questionId,
      rubricDigestSha256 }) => ({ questionId, rubricDigestSha256 }))), schemaVersion:
    "meeting_knowledge.semantic_quality_question_review.v1" };
  const reviewPaths = await Promise.all((["reviewer_1", "reviewer_2"] as const).map(
    async (role) => {const path = join(inputRoot, `${role}-review.json`);
      await writeFile(path, canonicalJson(authorities[role]!.signed(reviewPayload))); return path;}));
  const locatorPayload = { entriesSha256: sha256("entries"), releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_locator_authority.v1", snapshotSha256 };
  const mappingPath = join(inputRoot, "mapping.json");
  const forbiddenPath = join(inputRoot, "forbidden.json");
  await writeFile(mappingPath, canonicalJson(custody.signed(locatorPayload)));
  await writeFile(forbiddenPath, canonicalJson(custody.signed(locatorPayload)));
  const phasePath = join(root, "phase.json");
  const outputRoot = join(root, "prepared");
  const phase = { payload: { acceptanceReceiptPath: acceptancePath, admissionEpochMs: 1_000_000,
    authorityPolicyPath: policyPath, custodyAuthorityPath: custody.authorityPath,
    executionAuthorizationPath: authorizationPath, executionSignerPath: custody.signerPath,
    forbiddenLocatorManifestPath: forbiddenPath,
    goldRelevanceSignerPath: authorities.gold_relevance!.signerPath,
    locatorSignerPath: authorities.locator!.signerPath, outputRoot,
    questionReviewReceiptPaths: reviewPaths, releaseRootSha256,
    reviewerAuthorityPaths: [authorities.reviewer_1!.authorityPath,
      authorities.reviewer_2!.authorityPath], sealedCorpusPath,
    turnToBlockManifestPath: mappingPath }, schemaVersion:
    "meeting_knowledge.semantic_quality_corpus_admission_phase.v1" };
  await writeFile(phasePath, canonicalJson(phase));
  return { custodyAuthority: { keyId: custody.keyId, publicKeyPem: custody.publicKeyPem },
    keyIds: Object.fromEntries(Object.entries(authorities).map(([role, value]) =>
      [role, value.keyId])) as Record<string, string>, outputRoot, phasePath, root,
    signCustody: custody.signed };
}

async function authority(root: string, role: string) {
  const pair = generateKeyPairSync("ed25519");
  const keyId = `${role.replaceAll("_", "-")}-key`;
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const privatePath = join(root, `${role}-private.pem`);
  const publicPath = join(root, `${role}-public.pem`);
  const authorityPath = join(root, `${role}-authority.json`);
  const signerPath = join(root, `${role}-signer.json`);
  await writeFile(privatePath, pair.privateKey.export({ format: "pem", type: "pkcs8" }));
  await writeFile(publicPath, publicKeyPem);
  await writeFile(authorityPath, canonicalJson({ keyId, publicKeyPath: publicPath }));
  await writeFile(signerPath, canonicalJson({ keyId, privateKeyPath: privatePath }));
  return { authorityPath, keyId, publicKeyPem, signerPath,
    signed(payload: unknown) {return { payload, signatureBase64:
      sign(null, Buffer.from(canonicalJson(payload)), pair.privateKey).toString("base64"),
    signerKeyId: keyId };}, fingerprint: publicKeyFingerprintSha256(publicKeyPem, role) };
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function artifactBytes(root: string) {
  const names = ["InputManifest.v4.json", "automatic-questions.json",
    "corpus-admission-manifest.json", "execution-corpus.json", "forbidden-locators.json",
    "gold-relevance.json", "independent-review-questions.json", "locator-inventory.json",
    "question-review-1.json", "question-review-2.json"];
  return await Promise.all(names.map(async (name) => await readFile(join(root, name), "utf8")));
}
