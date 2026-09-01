import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const caddyfile = new URL("../../../infra/deployment/voicetext-gateway.Caddyfile", import.meta.url);
const caddy = process.env.VOICETEXT_CADDY_BIN ?? "caddy";
const probe = spawnSync(caddy, ["version"], { encoding: "utf8" });
const caddyAvailable = probe.status === 0;
const required = process.env.VOICETEXT_CADDY_ADAPT_REQUIRED === "1";

if (required && !caddyAvailable) {
  throw new Error(`offline Caddy adapter is required but ${caddy} is unavailable`);
}

describe("VoiceText Caddy routing", () => {
  it("uses mutually exclusive handles with a terminal 404", async () => {
    const source = await readFile(caddyfile, "utf8");
    expect(source).toMatch(/handle @voicetext_contract\s*\{[\s\S]*?reverse_proxy/u);
    expect(source).toMatch(/handle\s*\{\s*respond 404\s*\}/u);
    expect(source.indexOf("handle @voicetext_contract")).toBeLessThan(
      source.lastIndexOf("handle {"),
    );
  });

  it.runIf(caddyAvailable)("adapts the production Caddyfile entirely offline", () => {
    const result = spawnSync(caddy, [
      "adapt",
      "--adapter",
      "caddyfile",
      "--config",
      decodeURIComponent(caddyfile.pathname),
      "--pretty",
    ], {
      encoding: "utf8",
      env: { ...process.env, VOICETEXT_PUBLIC_HOST: "voice.example.test" },
    });
    expect(result.status).toBe(0);
    const adapted = JSON.parse(result.stdout) as {
      readonly apps?: { readonly http?: { readonly servers?: unknown } };
    };
    expect(adapted.apps?.http?.servers).toBeDefined();
    expect(result.stdout).toContain("voicetext-gateway:8080");
  });
});
