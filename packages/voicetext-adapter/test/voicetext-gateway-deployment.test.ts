import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const deploymentRoot = new URL("../../../infra/deployment/", import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);
const run = promisify(execFile);
interface ComposeDependency { condition: string }
interface ComposeVolume { read_only?: boolean; source: string; target: string }
interface ComposeService {
  build: { labels: Record<string, string> };
  depends_on: Record<string, ComposeDependency>;
  environment: Record<string, string>;
  healthcheck: { test: string[] };
  volumes: ComposeVolume[];
}
interface RenderedCompose { services: Record<string, ComposeService> }
let rendered: RenderedCompose;
let defaultServices: string[];
let fixtureRoot: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "oss-meeting-compose-"));
  await mkdir(join(fixtureRoot, "config"), { recursive: true });
  await writeFile(join(fixtureRoot, "config", "voicetext-gateway.env"), "", "utf8");
  const environmentFile = join(fixtureRoot, "deployment.env");
  await writeFile(environmentFile, [
    `DEPLOY_ROOT=${fixtureRoot}`,
    `MEETING_PLATFORM_SOURCE_REVISION=${"a".repeat(40)}`,
    "DISCORD_PUBLICATION_APPLICATION_ID=111111111111111111",
    "DISCORD_CRAIG_APPLICATION_ID=222222222222222222",
    "VOICETEXT_PUBLIC_HOST=voice.example.test",
  ].join("\n"), "utf8");

  const composeArguments = [
    "compose", "--env-file", environmentFile,
    "-f", "infra/deployment/compose.yaml",
    "-f", "infra/deployment/compose.craig.yaml",
    "-f", "infra/deployment/compose.voicetext-gateway.yaml",
    "config",
  ];
  const options = { cwd: repositoryRoot.pathname, maxBuffer: 10 * 1024 * 1024 };
  const config = await run("docker", [...composeArguments, "--format", "json"], options);
  rendered = JSON.parse(config.stdout) as RenderedCompose;
  const services = await run("docker", [...composeArguments, "--services"], options);
  defaultServices = services.stdout.trim().split("\n").filter(Boolean);
}, 30_000);

afterAll(async () => {
  if (fixtureRoot) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

describe("VoiceText gateway deployment overlay", () => {
  it("binds the build checkout, local image identity and OCI label to one verified commit", async () => {
    const compose = await readDeploymentFile("compose.voicetext-gateway.yaml");

    const revision = "17dcc80851327e8ff287aba4632f4638fdf087b1";
    expect(compose).toContain(`https://github.com/777genius/voicetext-gateway.git?ref=${revision}&checksum=${revision}`);
    expect(compose).toContain(`image: discord-meeting/voicetext-gateway:${revision}`);
    expect(compose).toContain(`org.opencontainers.image.revision: ${revision}`);
    expect(composeService("voicetext-gateway").build.labels["org.opencontainers.image.revision"]).toBe(revision);
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
    expect(caddy).toMatch(/handle @voicetext_contract\s*\{/u);
    expect(caddy).toMatch(/handle\s*\{\s*respond 404\s*\}/u);
  });

  it("documents bounded language qualification without claiming live acceptance", async () => {
    const guide = await readDeploymentFile("voicetext-gateway.md");

    expect(guide).toMatch(/languages depend on the selected provider and model/iu);
    expect(guide).toMatch(/Only English\s+and Russian provider flows are qualified/u);
    expect(guide).toMatch(/acceptance; that remains pending/iu);
  });

  it("documents a private-SaaS-free OSS topology and one safe smoke path", async () => {
    const guide = await readDeploymentFile("oss-meeting-topology.md");

    expect(guide).toContain("craig-lifecycle-v3");
    expect(guide).toMatch(/official Discord applications/iu);
    expect(guide).toMatch(/One config, up, and wait command/iu);
    expect(guide).toContain("up --build --detach --wait");
    expect(guide).toMatch(/Infinity Context[\s\S]*subscription-runtime[\s\S]*Pipecat/iu);
  });

  it("renders the complete core topology while excluding every optional profile", () => {
    expect(defaultServices.toSorted()).toEqual([
      "craig-bot", "craig-migrations", "craig-postgres", "craig-redis",
      "meeting-platform", "object-storage", "postgres", "postgres-migrations", "redis",
      "voicetext-edge", "voicetext-gateway", "voicetext-postgres",
    ].toSorted());
    expect(defaultServices).not.toEqual(expect.arrayContaining([
      "pipecat-runtime", "speaches", "subscription-runtime-sidecar",
    ]));
  });

  it("renders pinned Craig custody, health, and dependency fences", async () => {
    const craig = await readDeploymentFile("compose.craig.yaml");
    const revision = "37b86a958b567cb7fcff75946e94fe5e7ee38f42";
    expect(craig).toContain(`https://github.com/777genius/craig-meeting-gateway.git?ref=${revision}&checksum=${revision}`);
    expect(craig).toContain(`image: discord-meeting/craig-meeting-gateway:${revision}`);
    expect(composeService("craig-bot").build.labels["org.opencontainers.image.revision"]).toBe(revision);

    expect(composeService("craig-bot").depends_on).toMatchObject({
      "craig-migrations": { condition: "service_completed_successfully" },
      "craig-postgres": { condition: "service_healthy" },
      "craig-redis": { condition: "service_healthy" },
    });
    expect(composeService("craig-bot").healthcheck.test).toContain("/app/deploy/meeting/healthcheck.cjs");
    expect(composeDependency("voicetext-gateway", "voicetext-postgres").condition).toBe("service_healthy");
    expect(composeDependency("voicetext-edge", "voicetext-gateway").condition).toBe("service_healthy");
    expect(composeDependency("meeting-platform", "voicetext-edge").condition).toBe("service_healthy");
  });

  it("mounts separate bot secrets read-only and renders canonical application identities", () => {
    const craig = composeService("craig-bot");
    const platform = composeService("meeting-platform");
    const craigToken = craig.volumes.find((volume) => volume.target === "/run/secrets/discord-bot-token");
    const publicationSecrets = platform.volumes.find((volume) => volume.target === "/run/secrets");

    expect(craigToken?.read_only).toBe(true);
    expect(craigToken?.source).toContain("/secrets/craig/discord-bot-token");
    expect(publicationSecrets?.read_only).toBe(true);
    expect(publicationSecrets?.source).toContain("/secrets/platform");
    expect(craig.environment.DISCORD_APPLICATION_ID).toBe("222222222222222222");
    expect(platform.environment.DISCORD_APPLICATION_ID).toBe("111111111111111111");
    expect(platform.environment.DISCORD_BOTIK_APPLICATION_ID).toBe("111111111111111111");
    expect(platform.environment.DISCORD_CRAIG_APPLICATION_ID).toBe("222222222222222222");
  });

  it("documents the exact one-command workflow and honest default capability boundary", async () => {
    const guide = await readDeploymentFile("oss-meeting-topology.md");
    expect(guide.match(/config >\/dev\/null && docker compose/gu)).toHaveLength(1);
    expect(guide).toContain("node tooling/generate-build-provenance.mjs >/dev/null && docker compose");
    expect(guide).toContain("compose.craig.yaml");
    expect(guide).toMatch(/reports the authoritative transcript turn count and attaches the transcript/iu);
    expect(guide).toMatch(/Pipecat conversation profile[\s\S]*default-off and non-core/iu);
    expect(guide).toMatch(/Pipecat-to-VoiceText provider adapter[\s\S]*future/iu);
    expect(guide).toMatch(/restart count zero/iu);
    expect(guide).toMatch(/Do not add `--volumes`/u);
  });

  it("does not retain a private VoiceText SaaS endpoint as the Compose default", async () => {
    const [compose, environment] = await Promise.all([
      readDeploymentFile("compose.yaml"),
      readDeploymentFile(".env.example"),
    ]);

    expect(compose).not.toContain("api.voicetext.site");
    expect(environment).not.toContain("api.voicetext.site");
  });

  it("keeps hosted generation and Infinity out of the default OSS dependency graph", async () => {
    const [compose, hostedSummary, infinity] = await Promise.all([
      readDeploymentFile("compose.yaml"),
      readDeploymentFile("compose.hosted-summary.yaml"),
      readDeploymentFile("compose.infinity-context.yaml"),
    ]);

    expect(compose).toContain("profiles: [hosted-summary]");
    expect(compose).toContain("SUMMARY_PROVIDER: ${SUMMARY_PROVIDER:-transcript-outline}");
    expect(compose).toContain("VOICETEXT_LIVE_ENABLED: ${VOICETEXT_LIVE_ENABLED:-false}");
    expect(compose).not.toContain("INFINITY_CONTEXT_URL:");
    expect(compose).not.toContain("subscription-runtime-sidecar: { condition: service_started }");
    expect(hostedSummary).toContain("SUMMARY_PROVIDER: subscription-runtime");
    expect(hostedSummary).toContain("SUBSCRIPTION_RUNTIME_TOKEN_FILE:");
    expect(infinity).toContain("INFINITY_CONTEXT_URL:");
  });
});

async function readDeploymentFile(name: string): Promise<string> {
  return await readFile(new URL(name, deploymentRoot), "utf8");
}

function composeService(name: string): ComposeService {
  const service = rendered.services[name];
  if (!service) {
    throw new Error(`Rendered Compose is missing service ${name}`);
  }
  return service;
}

function composeDependency(serviceName: string, dependencyName: string): ComposeDependency {
  const dependency = composeService(serviceName).depends_on[dependencyName];
  if (!dependency) {
    throw new Error(`${serviceName} is missing dependency ${dependencyName}`);
  }
  return dependency;
}
