import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const deploymentRoot = new URL("../../../infra/deployment/", import.meta.url);

describe("VoiceText gateway deployment overlay", () => {
  it("binds the build checkout, local image identity and OCI label to one verified commit", async () => {
    const compose = await readDeploymentFile("compose.voicetext-gateway.yaml");

    expect(compose).toContain(
      "?ref=${VOICETEXT_GATEWAY_GIT_REF:?set gateway Git ref}&checksum=${VOICETEXT_GATEWAY_SOURCE_REVISION:?set exact gateway Git commit}",
    );
    expect(compose).toContain(
      "image: discord-meeting/voicetext-gateway:${VOICETEXT_GATEWAY_SOURCE_REVISION:?set exact gateway Git commit}",
    );
    expect(compose).toContain(
      "org.opencontainers.image.revision: ${VOICETEXT_GATEWAY_SOURCE_REVISION:?set exact gateway Git commit}",
    );
    expect(compose).not.toMatch(/image:\s+(?:ghcr\.io|docker\.io)\/[^\n]*voicetext-gateway/u);
    expect(compose).not.toContain("VOICETEXT_GATEWAY_SOURCE_ROOT");
  });

  it("keeps provider credentials in the gateway and gives Meeting Platform one contract URL", async () => {
    const compose = await readDeploymentFile("compose.voicetext-gateway.yaml");

    expect(compose).toContain(
      "${DEPLOY_ROOT:?set DEPLOY_ROOT}/secrets/voicetext/providers:/run/voicetext-provider-secrets:ro",
    );
    expect(compose).toContain(
      "VOICETEXT_WS_URL: wss://${VOICETEXT_PUBLIC_HOST:?set VoiceText public DNS hostname}/api/v1/transcribe/stream",
    );
    expect(compose.match(/VOICETEXT_WS_URL:/gu)).toHaveLength(1);
    expect(compose).not.toMatch(/(?:DEEPGRAM|ELEVENLABS)_API_KEY.*meeting-platform/iu);
  });

  it("publishes only the VoiceText v2/v3-compatible and health routes", async () => {
    const caddy = await readDeploymentFile("voicetext-gateway.Caddyfile");

    expect(caddy).toContain("/api/v1/transcribe/batch");
    expect(caddy).toContain("/api/v1/transcribe/batch/*");
    expect(caddy).toContain("/api/v1/transcribe/stream");
    expect(caddy).toContain("/health/ready");
    expect(caddy).toContain("respond 404");
  });

  it("documents bounded language qualification without claiming live acceptance", async () => {
    const guide = await readDeploymentFile("voicetext-gateway.md");

    expect(guide).toMatch(/languages depend on the selected provider and model/iu);
    expect(guide).toMatch(/Only English\s+and Russian provider flows are qualified/u);
    expect(guide).toMatch(/acceptance; that remains pending/iu);
  });
});

async function readDeploymentFile(name: string): Promise<string> {
  return await readFile(new URL(name, deploymentRoot), "utf8");
}
