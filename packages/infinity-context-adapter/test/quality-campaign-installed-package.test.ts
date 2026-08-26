import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createHttpQualityCampaignProductionPorts, executeHoldoutSchedule,
  type CampaignQuestion, type QualityCampaignRelease } from
  "@discord-meeting/infinity-context-adapter/quality-campaign";

const execute = promisify(execFile);
const servers: ReturnType<typeof createServer>[] = [];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

afterEach(async () => {await Promise.all(servers.splice(0).map(async (server) =>
  await new Promise<void>((resolve) => {server.close(() => {resolve();});})))});

describe("packed production quality-campaign entrypoint", () => {
  it("installs and launches without tsx or workspace-transitive dependencies", async () => {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const packRoot = await mkdtemp(join(tmpdir(), "quality-npm-pack-"));
    await execute("npm", ["pack", "--json", "--pack-destination", packRoot], {
      cwd: packageRoot, timeout: 120_000 });
    const archive = (await readdir(packRoot)).find((value) => value.endsWith(".tgz"));
    expect(archive).toBeDefined();
    const consumerRoot = await mkdtemp(join(tmpdir(), "quality-npm-consumer-"));
    await execute("npm", ["install", "--prefix", consumerRoot, "--ignore-scripts",
      "--omit=optional", "--package-lock=false", join(packRoot, archive!)], { timeout: 60_000 });
    const bin = join(consumerRoot, "node_modules", ".bin", "discord-meeting-quality-campaign");
    await expect(execute(bin, [], { timeout: 10_000 })).rejects.toMatchObject({ code: 1,
      stderr: "" });
    const subpath = join(consumerRoot, "node_modules", "@discord-meeting",
      "infinity-context-adapter", "dist", "quality-campaign", "production-cli.js");
    await expect(execute(process.execPath, ["--input-type=module", "--eval",
      `const m=await import(${JSON.stringify(subpath)});if(typeof m.runQualityCampaignProductionCli!=="function")process.exit(2)`],
    { timeout: 10_000 })).resolves.toMatchObject({ stderr: "" });
  }, 180_000);

  it("uses the default HTTP factory and aborts an in-flight call", async () => {
    let slowRequestAborted = false;
    let markSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {markSlowStarted = resolve;});
    const server = createServer((request, response) => {
      if (request.url === "/release") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ observed: true })); return;
      }
      markSlowStarted();
      request.on("aborted", () => {slowRequestAborted = true;});
      request.on("close", () => {slowRequestAborted = true;});
    });
    servers.push(server);
    await new Promise<void>((resolve) => {server.listen(0, "127.0.0.1", () => {resolve();});});
    const address = server.address();
    if (address === null || typeof address === "string") {throw new Error("fake HTTP address failed");}
    const base = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(join(tmpdir(), "quality-http-factory-"));
    const tokenPath = join(root, "token"); await writeFile(tokenPath, "local-only-token");
    const authority = async (name: string) => {
      const keys = generateKeyPairSync("ed25519");
      const publicKeyPath = join(root, `${name}.pem`);
      await writeFile(publicKeyPath, keys.publicKey.export({ format: "pem", type: "spki" }));
      return { keyId: name, publicKeyPath };
    };
    const [absenceAuthority, deletionAuthority, mainResult, holdoutResult,
      first, second, resolver] = await Promise.all(["absence", "deletion", "main-result",
      "holdout-result", "first", "second", "resolver"].map(authority));
    const connectionsPath = join(root, "connections.json");
    await writeFile(connectionsPath, JSON.stringify({ absenceAuthority,
      absenceEndpoint: `${base}/absence`, adjudicators: [first, second, resolver].map((value,
        index) => ({ ...value, endpoint: `${base}/judge-${index}` })),
      answerEndpoint: `${base}/slow`, capabilityEndpoint: `${base}/slow`,
      credentialPath: tokenPath, deletionAuthority, deletionEndpoint: `${base}/deletion`,
      evidenceEndpoint: `${base}/evidence`, holdoutAnswerEndpoint: `${base}/holdout-answer`,
      holdoutCapabilityEndpoint: `${base}/holdout-capability`, holdoutEvidenceEndpoint:
      `${base}/holdout-evidence`, holdoutProviderResultAuthority: holdoutResult,
      holdoutRetrievalEndpoint: `${base}/holdout-retrieval`, providerResultAuthority: mainResult,
      rawOutcomeEndpoint: `${base}/raw`, releaseObservationEndpoint: `${base}/release`,
      retrievalEndpoint: `${base}/slow`, schemaVersion:
      "meeting_knowledge.semantic_quality_http_connections.v2" }));
    const ports = await createHttpQualityCampaignProductionPorts(connectionsPath);
    const context = { deadlineEpochMs: Date.now() + 5_000,
      signal: new AbortController().signal };
    await expect(ports.release.observe(context)).resolves.toEqual({ observed: true });
    const holdoutQuestions: CampaignQuestion[] = Array.from({ length: 30 }, (_, index) => ({
      locale: "en", questionDigestSha256: digest(`question-${index}`),
      questionId: `installed-${index}`, rubricDigestSha256: digest(`rubric-${index}`),
      source: "independent_review" }));
    const started = Date.now();
    const pendingSchedule = executeHoldoutSchedule({ binding: { campaignRootSha256:
      digest("campaign"), release: {} as QualityCampaignRelease,
      releaseRootSha256: digest("release"), spendReservationSha256: digest("spend") },
    clock: { nowEpochMs: () => Date.now() }, concurrency: 2,
    deadlineEpochMs: Date.now() + 1_000, journalRoot: join(root, "deadline-journal"),
    ports: ports.mainProvider, questions: holdoutQuestions });
    await slowStarted;
    const scheduled = await pendingSchedule;
    expect(scheduled.outcomeUnknown).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
    await new Promise<void>((resolve) => {setTimeout(resolve, 20);});
    expect(slowRequestAborted).toBe(true);
  }, 30_000);
});
