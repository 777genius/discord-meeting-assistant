import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink,
  writeFile } from "node:fs/promises";
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
      statusPath], corpusAdmissionClock: fixedClock() })).resolves.toBe(0);

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
    const locatorInventory = await json(join(fixture.outputRoot, "locator-inventory.json")) as {
      payload: { locatorIds: string[] } };
    expect(locatorInventory.payload.locatorIds).toContain(sha256("distractor:0"));
    const forbiddenEvidence = await json(join(fixture.outputRoot, "forbidden-locators.json")) as {
      payload: Record<string, unknown> };
    expect(Object.keys(forbiddenEvidence.payload).toSorted()).toEqual(["campaignRootSha256",
      "forbiddenLocatorIds", "questionSetSha256", "releaseRootSha256", "schemaVersion"]);
    expect(forbiddenEvidence.payload.schemaVersion)
      .toBe("meeting_knowledge.semantic_quality_forbidden_locators.v2");
    expect(Array.isArray(forbiddenEvidence.payload.forbiddenLocatorIds)).toBe(true);
    expect(forbiddenEvidence.payload).not.toHaveProperty("entries");
    const first = await artifactBytes(fixture.outputRoot);

    const secondOutputRoot = join(fixture.root, "prepared-second");
    const secondPhase = await json(fixture.phasePath) as { payload: Record<string, unknown>;
      schemaVersion: string };
    secondPhase.payload.outputRoot = secondOutputRoot;
    const secondPhasePath = join(fixture.root, "phase-second.json");
    await writeFile(secondPhasePath, canonicalJson(secondPhase));
    await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", secondPhasePath,
      join(fixture.root, "status-second.json")], corpusAdmissionClock: fixedClock() })).resolves.toBe(0);
    expect(await artifactBytes(secondOutputRoot)).toEqual(first);
  });

  it("fails closed for tampering, wrong counts, cross-scope bindings, and path substitution",
    async () => {
      for (const mutation of ["tamper", "hash", "unsigned", "count", "duplicate", "version",
        "scope", "path", "auth-version", "auth-disabled", "auth-expired", "symlink",
        "authority-symlink", "duplicate-json", "array-overlap", "nested-overlap"] as const) {
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
        } else if (mutation === "authority-symlink") {
          const authorityPath = String(phase.payload.custodyAuthorityPath);
          const authorityDocument = await json(authorityPath) as { publicKeyPath: string };
          const targetPath = `${authorityDocument.publicKeyPath}.target`;
          await rename(authorityDocument.publicKeyPath, targetPath);
          await symlink(targetPath, authorityDocument.publicKeyPath);
        } else if (mutation === "duplicate-json") {
          const corpusPath = String(phase.payload.sealedCorpusPath);
          const bytes = await readFile(corpusPath, "utf8");
          await writeFile(corpusPath,
            `{"schemaVersion":"meeting_knowledge.semantic_quality_sealed_corpus.v1",${bytes.slice(1)}`);
        } else if (mutation === "array-overlap") {
          const paths = phase.payload.questionReviewReceiptPaths as string[];
          phase.payload.questionReviewReceiptPaths = [paths[0], paths[0]];
          await writeFile(fixture.phasePath, canonicalJson(phase));
        } else {
          phase.payload.authorityPolicyPath = join(String(phase.payload.sealedCorpusPath), "nested");
          await writeFile(fixture.phasePath, canonicalJson(phase));
        }
        await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
          join(fixture.root, `status-${mutation}.json`)], corpusAdmissionClock: fixedClock() }))
          .resolves.toBe(1);
      }
    });
});

describe("quality campaign corpus admission filesystem hardening", () => {
  it("rejects 101 global forbidden locators at the same bound used by evidence validation",
    async () => {
      const fixture = await createFixture(101);
      await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
        join(fixture.root, "status.json")], corpusAdmissionClock: fixedClock() })).resolves.toBe(1);
      await expect(lstat(fixture.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });

  it("allows many turns per source block but rejects one turn mapped to two blocks", async () => {
    const fixture = await createFixture(12, true);
    await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
      join(fixture.root, "status.json")], corpusAdmissionClock: fixedClock() })).resolves.toBe(1);
  });

  it("rejects duplicate phase JSON and symlinks in phase or authority ancestors", async () => {
    for (const mutation of ["duplicate-phase", "duplicate-policy", "phase-ancestor",
      "authority-ancestor"] as const) {
      const fixture = await createFixture();
      let phasePath = fixture.phasePath;
      if (mutation === "duplicate-phase") {
        const bytes = await readFile(phasePath, "utf8");
        await writeFile(phasePath, bytes.replace("{", "{\"schemaVersion\":\"duplicate\","));
      } else if (mutation === "duplicate-policy") {
        const phase = await json(phasePath) as { payload: Record<string, unknown> };
        const policyPath = String(phase.payload.authorityPolicyPath);
        const bytes = await readFile(policyPath, "utf8");
        await writeFile(policyPath, bytes.replace("{", "{\"artifact_custody\":\"duplicate\","));
      } else if (mutation === "phase-ancestor") {
        const actual = join(fixture.root, "actual-phase-parent");
        await mkdir(actual); await rename(phasePath, join(actual, "phase.json"));
        const linked = join(fixture.root, "linked-phase-parent"); await symlink(actual, linked);
        phasePath = join(linked, "phase.json");
      } else {
        const phase = await json(phasePath) as { payload: Record<string, unknown> };
        const policyPath = String(phase.payload.authorityPolicyPath);
        const actual = join(fixture.root, "actual-policy-parent"); await mkdir(actual);
        await rename(policyPath, join(actual, "policy.json"));
        const linked = join(fixture.root, "linked-policy-parent"); await symlink(actual, linked);
        phase.payload.authorityPolicyPath = join(linked, "policy.json");
        await writeFile(phasePath, canonicalJson(phase));
      }
      await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", phasePath,
        join(fixture.root, `status-${mutation}.json`)], corpusAdmissionClock: fixedClock() }))
        .resolves.toBe(1);
      await expect(lstat(fixture.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("uses the trusted runtime epoch and binds it into the completion marker", async () => {
    const expired = await createFixture();
    const phase = await json(expired.phasePath) as { payload: Record<string, unknown> };
    phase.payload.admissionEpochMs = 0;
    await writeFile(expired.phasePath, canonicalJson(phase));
    await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", expired.phasePath,
      join(expired.root, "expired-status.json")], corpusAdmissionClock: fixedClock(2_000_000) }))
      .resolves.toBe(1);
    await expect(lstat(expired.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    delete phase.payload.admissionEpochMs; await writeFile(expired.phasePath, canonicalJson(phase));
    await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", expired.phasePath,
      join(expired.root, "expired-status-2.json")], corpusAdmissionClock: fixedClock(2_000_000) }))
      .resolves.toBe(1);

    const admitted = await createFixture();
    await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", admitted.phasePath,
      join(admitted.root, "status.json")], corpusAdmissionClock: fixedClock(1_234_567) }))
      .resolves.toBe(0);
    await expect(json(join(admitted.outputRoot, "corpus-admission-manifest.json")))
      .resolves.toMatchObject({ authorizationComparisonEpochMs: 1_234_567,
        completionState: "complete" });
  });

  it("rejects swapped purpose receipts and wrong actual-dataset digests", async () => {
    for (const mutation of ["swapped", "wrong-digest"] as const) {
      const fixture = await createFixture();
      const phase = await json(fixture.phasePath) as { payload: Record<string, unknown> };
      if (mutation === "swapped") {
        const mapping = phase.payload.turnToBlockManifestPath;
        phase.payload.turnToBlockManifestPath = phase.payload.forbiddenLocatorManifestPath;
        phase.payload.forbiddenLocatorManifestPath = mapping;
        await writeFile(fixture.phasePath, canonicalJson(phase));
      } else {
        const path = String(phase.payload.turnToBlockManifestPath);
        const receipt = await json(path) as { payload: Record<string, unknown> };
        receipt.payload.turnMappingsSha256 = sha256("unrelated mapping entries");
        await writeFile(path, canonicalJson(fixture.signCustody(receipt.payload)));
      }
      await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
        join(fixture.root, `status-${mutation}.json`)], corpusAdmissionClock: fixedClock() }))
        .resolves.toBe(1);
      await expect(lstat(fixture.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("publishes create-only under collisions and concurrent races", async () => {
    for (const collision of ["directory", "symlink", "ancestor"] as const) {
      const fixture = await createFixture();
      if (collision === "directory") {await mkdir(fixture.outputRoot);}
      else if (collision === "symlink") {
        await symlink(join(fixture.root, "missing-target"), fixture.outputRoot);
      } else {
        const phase = await json(fixture.phasePath) as { payload: Record<string, unknown> };
        const actual = join(fixture.root, "actual-output-parent"); await mkdir(actual);
        const linked = join(fixture.root, "linked-output-parent"); await symlink(actual, linked);
        phase.payload.outputRoot = join(linked, "prepared");
        await writeFile(fixture.phasePath, canonicalJson(phase));
      }
      await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
        join(fixture.root, `status-${collision}.json`)], corpusAdmissionClock: fixedClock() }))
        .resolves.toBe(1);
    }
    const fixture = await createFixture();
    const outcomes = await Promise.all(["one", "two"].map(async (suffix) =>
      await runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
        join(fixture.root, `status-race-${suffix}.json`)], corpusAdmissionClock: fixedClock() })));
    expect(outcomes.toSorted((left, right) => left - right)).toEqual([0, 1]);
    expect(await json(join(fixture.outputRoot, "corpus-admission-manifest.json")))
      .toMatchObject({ completionState: "complete" });
  });

  it("prevalidates status custody and preserves a valid corpus across ambiguous retry", async () => {
    for (const mutation of ["collision", "output-root", "inside", "symlink-parent"] as const) {
      const fixture = await createFixture();
      let statusPath: string;
      if (mutation === "collision") {statusPath = fixture.phasePath;}
      else if (mutation === "output-root") {statusPath = fixture.outputRoot;}
      else if (mutation === "inside") {statusPath = join(fixture.outputRoot, "status.json");}
      else {
        const actual = join(fixture.root, `status-parent-${mutation}`); await mkdir(actual);
        const linked = join(fixture.root, "linked-status-parent"); await symlink(actual, linked);
        statusPath = join(linked, "status.json");
      }
      await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
        statusPath], corpusAdmissionClock: fixedClock() })).resolves.toBe(1);
      await expect(lstat(fixture.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expectUnwritableStatusCustodyFailure();

    const fixture = await createFixture(); const statusPath = join(fixture.root, "status.json");
    await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
      statusPath], corpusAdmissionClock: fixedClock() })).resolves.toBe(0);
    const before = await artifactBytes(fixture.outputRoot);
    await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
      statusPath], corpusAdmissionClock: fixedClock() })).resolves.toBe(1);
    expect(await artifactBytes(fixture.outputRoot)).toEqual(before);
  });

  it("rejects partial publication until its durable completion marker is recovered", async () => {
    const fixture = await createFixture(); const statusPath = join(fixture.root, "status.json");
    await expect(runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
      statusPath], corpusAdmissionClock: fixedClock() })).resolves.toBe(0);
    const status = await json(statusPath) as { digests: { campaignRootSha256: string } };
    const marker = join(fixture.outputRoot, "corpus-admission-manifest.json");
    const retainedMarker = join(fixture.root, "retained-completion.json"); await rename(marker,
      retainedMarker);
    const load = () => loadProductionExecutionCorpus({ authority: fixture.custodyAuthority,
      campaignRootSha256: status.digests.campaignRootSha256, expectedQuestionCount: 240,
      executionPacketPath: join(fixture.outputRoot, "execution-corpus.json") });
    await expect(load()).rejects.toThrow(/completion manifest/u);
    await rename(retainedMarker, marker);
    await expect(load()).resolves.toHaveLength(240);
  });
});

async function expectUnwritableStatusCustodyFailure() {
  const fixture = await createFixture();
  const statusParent = join(fixture.root, "status-parent-unwritable");
  const statusPath = join(statusParent, "status.json");
  const unprivilegedUid = 65_534;
  const unprivilegedGid = 65_534;
  const useUnprivilegedChild = process.platform === "linux" && process.getuid?.() === 0;
  if (useUnprivilegedChild) {
    for (const path of await readdir(fixture.root, { recursive: true })) {
      await chown(join(fixture.root, path), unprivilegedUid, unprivilegedGid);
    }
    await chown(fixture.root, unprivilegedUid, unprivilegedGid);
  }
  await mkdir(statusParent);
  if (useUnprivilegedChild) {
    await chown(statusParent, unprivilegedUid, unprivilegedGid);
  }
  await chmod(statusParent, 0o500);
  const runAdmission = async () => {
    if (!useUnprivilegedChild) {
      return await runQualityCampaignProductionCli({ argv: ["corpus-admit", fixture.phasePath,
        statusPath], corpusAdmissionClock: fixedClock() });
    }
    const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx/esm"),
      new URL("./fixtures/quality-corpus-admission-child.ts", import.meta.url).pathname,
      fixture.phasePath, statusPath], { encoding: "utf8", gid: unprivilegedGid,
      maxBuffer: 64 * 1_024, timeout: 10_000, uid: unprivilegedUid });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).not.toBeNull();
    expect(child.stderr).toBe("");
    return child.status;
  };
  await expect(runAdmission()).resolves.toBe(1);
  await expect(lstat(fixture.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await chmod(statusParent, 0o700);
  await expect(runAdmission()).resolves.toBe(0);
  await expect(json(join(fixture.outputRoot, "corpus-admission-manifest.json")))
    .resolves.toMatchObject({ completionState: "complete" });
}

async function createFixture(forbiddenCount = 12, inconsistentTurnMapping = false) {
  const root = await mkdtemp(join(tmpdir(), "quality-corpus-admission-test-"));
  const inputRoot = join(root, "inputs");
  await mkdir(inputRoot);
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
    return { execution, gold };
  });
  const forbiddenLocatorIds = Array.from({ length: forbiddenCount }, (_, index) =>
    sha256(`global-forbidden:${index}`));
  const turnMappings = entries.flatMap(({ gold }, index) => [
    ...gold.evidenceLocators.map((sourceLocatorId) => ({ sourceLocatorId, turnId: `turn-${index}` })),
    { sourceLocatorId: sha256(`distractor:${index}`), turnId: `distractor-turn-${index}` },
  ]);
  turnMappings.push({ sourceLocatorId: entries[1]!.gold.evidenceLocators[0]!,
    turnId: "second-turn-in-the-same-source-block" });
  if (inconsistentTurnMapping) {turnMappings.push({ sourceLocatorId: sha256("another-block"),
    turnId: "turn-1" });}
  const corpus = { entries, forbiddenLocatorIds, releaseRootSha256, reviewerDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_sealed_corpus.v1",
    snapshotSha256, sourceDigestSha256, turnMappings };
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
  const mappingPayload = { turnMappingsSha256: sha256({ dataset: turnMappings,
    purpose: "turn_to_source_locator_authority" }), releaseRootSha256,
  schemaVersion: "meeting_knowledge.semantic_quality_locator_authority.v1", snapshotSha256 };
  const forbiddenPayload = { forbiddenLocatorSetSha256: sha256({ dataset: forbiddenLocatorIds,
    purpose: "global_forbidden_locator_authority" }), releaseRootSha256,
  schemaVersion: "meeting_knowledge.semantic_quality_locator_authority.v1", snapshotSha256 };
  const mappingPath = join(inputRoot, "mapping.json");
  const forbiddenPath = join(inputRoot, "forbidden.json");
  await writeFile(mappingPath, canonicalJson(custody.signed(mappingPayload)));
  await writeFile(forbiddenPath, canonicalJson(custody.signed(forbiddenPayload)));
  const phasePath = join(root, "phase.json");
  const outputRoot = join(root, "prepared");
  const phase = { payload: { acceptanceReceiptPath: acceptancePath,
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
    signCustody: (payload: unknown) => custody.signed(payload) };
}

function fixedClock(nowEpochMs = 1_000_000) {return { nowEpochMs: () => nowEpochMs };}

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
