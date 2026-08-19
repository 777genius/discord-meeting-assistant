import { describe, it } from "vitest";

import { runRealServiceQualification } from "./real-service-qualification-helper.js";

const enabled = process.env.INFINITY_CONTEXT_REAL_E2E === "1";
const liveDescribe = enabled ? describe : describe.skip;

liveDescribe("Infinity Context disposable real-service qualification", () => {
  it("qualifies real HTTP hybrid retrieval and removes all remote test evidence", async () => {
    const config = realServiceConfig(process.env);
    const metrics = await runRealServiceQualification(config);
    process.stdout.write(`INFINITY_CONTEXT_REAL_E2E_RESULT ${JSON.stringify(metrics)}\n`);
  }, 600_000);
});

function realServiceConfig(environment: NodeJS.ProcessEnv) {
  if (environment.INFINITY_CONTEXT_REAL_E2E !== "1") {
    throw new Error("INFINITY_CONTEXT_REAL_E2E must equal 1");
  }
  if (environment.INFINITY_CONTEXT_REAL_E2E_DISPOSABLE !== "YES_DELETE_ALL_TEST_DATA") {
    throw new Error(
      "INFINITY_CONTEXT_REAL_E2E_DISPOSABLE must equal YES_DELETE_ALL_TEST_DATA",
    );
  }
  if (environment.INFINITY_CONTEXT_REAL_E2E_EMBEDDINGS !== "deterministic-mock-non-production-v1") {
    throw new Error(
      "INFINITY_CONTEXT_REAL_E2E_EMBEDDINGS must equal deterministic-mock-non-production-v1; mock embeddings prove plumbing only and are not production qualification",
    );
  }
  const rawUrl = environment.INFINITY_CONTEXT_REAL_E2E_URL;
  if (rawUrl === undefined || rawUrl.trim() === "") {
    throw new Error("INFINITY_CONTEXT_REAL_E2E_URL is required when the real E2E is enabled");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("INFINITY_CONTEXT_REAL_E2E_URL must be a valid absolute URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
    url.pathname !== "/") {
    throw new Error("INFINITY_CONTEXT_REAL_E2E_URL must be an HTTP(S) service root without credentials, query, or fragment");
  }
  const timeout = Number(environment.INFINITY_CONTEXT_REAL_E2E_REQUEST_TIMEOUT_MS ?? "30000");
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 60_000) {
    throw new Error("INFINITY_CONTEXT_REAL_E2E_REQUEST_TIMEOUT_MS must be an integer from 1000 through 60000");
  }
  return {
    baseUrl: url.toString().replace(/\/$/u, ""),
    requestTimeoutMs: timeout,
    ...(environment.INFINITY_CONTEXT_REAL_E2E_TOKEN === undefined
      ? {}
      : { token: environment.INFINITY_CONTEXT_REAL_E2E_TOKEN }),
  };
}
