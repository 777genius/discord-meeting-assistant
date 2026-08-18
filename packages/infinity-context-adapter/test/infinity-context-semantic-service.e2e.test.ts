import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createInfinitySemanticQualificationManifest } from "../src/index.js";
import { combinedQualificationMeeting } from "./infinity-context-qualification-corpus.js";
import { runRealServiceQualification } from "./real-service-qualification-helper.js";

const enabled = process.env.INFINITY_CONTEXT_SEMANTIC_E2E === "1";
const liveDescribe = enabled ? describe : describe.skip;
const execFileAsync = promisify(execFile);

liveDescribe("Infinity Context disposable production-semantic qualification", () => {
  it("qualifies one declared non-mock embedding profile and emits a retainable manifest", async () => {
    const config = await semanticServiceConfig(process.env);
    const metrics = await runRealServiceQualification(config.service);
    expect(metrics.focusedRecallAt5).toBe(1);
    const meeting = combinedQualificationMeeting();
    const manifest = createInfinitySemanticQualificationManifest({
      corpusHumanTurnsSha256: createHash("sha256")
        .update(JSON.stringify(meeting.humanTurns), "utf8")
        .digest("hex"),
      endpointReceipt: metrics.endpointReceipt,
      focusedQuestionCount: metrics.focusedQuestionCount,
      focusedRecallAt5: metrics.focusedRecallAt5,
      observedAt: new Date().toISOString(),
      releaseRevision: config.releaseRevision,
      qualificationHarnessSha256: config.qualificationHarnessSha256,
      releaseSourceTreeSha256: config.releaseSourceTreeSha256,
      remoteCleanupVerified: metrics.remoteCleanupVerified,
      turnCount: metrics.turnCount,
    });
    process.stdout.write(
      `INFINITY_CONTEXT_SEMANTIC_QUALIFICATION_MANIFEST ${JSON.stringify(manifest)}\n`,
    );
  }, 600_000);
});

export async function semanticServiceConfig(
  environment: NodeJS.ProcessEnv,
  resolveCheckoutProvenance: () => Promise<QualificationCheckoutProvenance> = checkoutQualificationProvenance,
) {
  required(
    environment.INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE,
    "INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE",
    "YES_DELETE_ALL_TEST_DATA",
  );
  const baseUrl = required(
    environment.INFINITY_CONTEXT_SEMANTIC_E2E_URL,
    "INFINITY_CONTEXT_SEMANTIC_E2E_URL",
  );
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("INFINITY_CONTEXT_SEMANTIC_E2E_URL must be a valid absolute URL");
  }
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    url.username !== "" || url.password !== "" || url.search !== "" ||
    url.hash !== "" || url.pathname !== "/"
  ) {
    throw new Error(
      "INFINITY_CONTEXT_SEMANTIC_E2E_URL must be an HTTP(S) service root without credentials, query, or fragment",
    );
  }
  const requestTimeoutMs = Number(
    environment.INFINITY_CONTEXT_SEMANTIC_E2E_REQUEST_TIMEOUT_MS ?? "30000",
  );
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 60_000) {
    throw new Error(
      "INFINITY_CONTEXT_SEMANTIC_E2E_REQUEST_TIMEOUT_MS must be an integer from 1000 through 60000",
    );
  }
  const provenance = await resolveCheckoutProvenance();
  return {
    releaseRevision: revision(
      provenance.releaseRevision,
      "checked-out release revision",
    ),
    qualificationHarnessSha256: provenance.qualificationHarnessSha256,
    releaseSourceTreeSha256: provenance.sourceTreeSha256,
    service: {
      baseUrl: url.toString().replace(/\/$/u, ""),
      requestTimeoutMs,
      ...(environment.INFINITY_CONTEXT_SEMANTIC_E2E_TOKEN === undefined
        ? {}
        : { token: environment.INFINITY_CONTEXT_SEMANTIC_E2E_TOKEN }),
    },
  };
}

interface QualificationCheckoutProvenance {
  readonly qualificationHarnessSha256: string;
  readonly releaseRevision: string;
  readonly sourceTreeSha256: string;
}

const qualificationHarnessPaths = Object.freeze([
  "packages/infinity-context-adapter/src/infinity-semantic-qualification.ts",
  "packages/infinity-context-adapter/test/infinity-context-qualification-corpus.ts",
  "packages/infinity-context-adapter/test/infinity-context-semantic-service.e2e.test.ts",
  "packages/infinity-context-adapter/test/real-service-qualification-helper.ts",
]);

async function git(args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout;
}

export async function checkoutQualificationProvenance(
  runGit: (args: readonly string[]) => Promise<string> = git,
): Promise<QualificationCheckoutProvenance> {
  if ((await runGit(["status", "--porcelain=v1", "--untracked-files=all"])).length !== 0) {
    throw new Error("semantic qualification requires a clean Git checkout");
  }
  const releaseRevision = (await runGit(["rev-parse", "--verify", "HEAD"])).trim();
  const treeListing = await runGit(["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
  const harness = createHash("sha256");
  for (const path of qualificationHarnessPaths) {
    harness.update(path, "utf8");
    harness.update("\0", "utf8");
    harness.update(await runGit(["show", `HEAD:${path}`]), "utf8");
    harness.update("\0", "utf8");
  }
  return {
    qualificationHarnessSha256: harness.digest("hex"),
    releaseRevision,
    sourceTreeSha256: createHash("sha256").update(treeListing, "utf8").digest("hex"),
  };
}

function required(value: string | undefined, field: string, exact?: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  if (exact !== undefined && value !== exact) {
    throw new Error(`${field} must equal ${exact}`);
  }
  return value.trim();
}

function revision(value: string | undefined, field: string): string {
  const normalized = required(value, field);
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error(`${field} must be an exact 40-character git revision`);
  }
  return normalized;
}
