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
  resolveCheckoutRevision: () => Promise<string> = checkoutRevision,
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
  return {
    releaseRevision: revision(
      await resolveCheckoutRevision(),
      "checked-out release revision",
    ),
    service: {
      baseUrl: url.toString().replace(/\/$/u, ""),
      requestTimeoutMs,
      ...(environment.INFINITY_CONTEXT_SEMANTIC_E2E_TOKEN === undefined
        ? {}
        : { token: environment.INFINITY_CONTEXT_SEMANTIC_E2E_TOKEN }),
    },
  };
}

async function checkoutRevision(): Promise<string> {
  const result = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
  });
  return result.stdout.trim();
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
