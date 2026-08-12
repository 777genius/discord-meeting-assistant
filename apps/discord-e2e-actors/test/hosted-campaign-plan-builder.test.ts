import { describe, expect, it } from "vitest";

import {
  buildResolvedHostedCampaignPlanV1,
  compileHostedCampaignDefinitionV1,
} from "../src/hosted-campaign-plan-builder.js";
import { parseHostedCampaignPlan } from "../src/hosted-campaign-run-config.js";

const definition = () => ({
  answerFirstPacketMilliseconds: 4_000,
  campaignId: "campaign-2026-08-12",
  campaignRoot: "/private/e2e/campaigns",
  clockPreflightPath: "/private/e2e/clock/preflight.json",
  fixtureManifestPath: "/private/e2e/fixtures/manifest.json",
  recordingPlaybackOrigin: "https://recordings.test.example",
  remote: {
    composeFile: "/srv/discord-meeting/source/infra/deployment/compose.yaml",
    environmentFile: "/srv/discord-meeting/source.env",
    sourceRoot: "/srv/discord-meeting/source",
  },
  revisions: {
    craig: "a".repeat(40), meetingPlatform: "b".repeat(40),
    pipecat: "c".repeat(40), subscriptionRuntime: "d".repeat(40),
  },
  runIds: ["campaign-run-1", "campaign-run-2", "campaign-run-3"],
  schemaVersion: 1,
  secretDirectory: "/run/secrets/discord-e2e",
  speakerFixtures: { a: "/private/e2e/fixtures/speaker-a.ogg", b: "/private/e2e/fixtures/speaker-b.ogg" },
  serviceLevelThresholdsPath: "/private/e2e/fixtures/service-level-thresholds.json",
  supplementalManifestPath: "/private/e2e/fixtures/supplemental-manifest.json",
} as const);

const bindings = () => ({
  runs: [1, 2, 3].map((ordinal) => ({
    remoteAttestationPath: `/tmp/discord-e2e-attestations/campaign-run-${ordinal}.json`,
  })),
  schemaVersion: 1,
});

describe("hosted campaign strict plan builder", () => {
  it("returns a stable blocked report and no plan until authoritative runtime bindings exist", () => {
    const result = compileHostedCampaignDefinitionV1(definition());

    expect(result).toEqual({
      blockedReasons: ["DYNAMIC_RUNTIME_BINDINGS_REQUIRED"],
      requiredBindings: [
        { key: "runs.0.remoteAttestationPath", source: "operator-selected-create-only-attestation-path" },
        { key: "runs.1.remoteAttestationPath", source: "operator-selected-create-only-attestation-path" },
        { key: "runs.2.remoteAttestationPath", source: "operator-selected-create-only-attestation-path" },
      ],
      schemaVersion: 1,
      status: "blocked",
    });
    expect("plan" in result).toBe(false);
  });

  it("compiles exactly three ordered runs and a closed executable graph after binding", () => {
    const result = compileHostedCampaignDefinitionV1(definition(), bindings());
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {throw new Error("Expected a ready plan");}

    expect(result.plan.runs).toEqual([
      { campaignId: "campaign-2026-08-12", ordinal: 1, retainedCaptureCount: 0, runId: "campaign-run-1", scenario: "sequential" },
      { campaignId: "campaign-2026-08-12", ordinal: 2, retainedCaptureCount: 0, runId: "campaign-run-2", scenario: "overlap" },
      { campaignId: "campaign-2026-08-12", ordinal: 3, retainedCaptureCount: 6, runId: "campaign-run-3", scenario: "reconnect" },
    ]);
    expect(parseHostedCampaignPlan(result.plan)).toEqual(result.plan);
    expect(result.plan.children.map(({ childId }) => childId)).toEqual([
      "actor-1", "actor-2", "actor-3", "provenance-before", "recording-ready-1", "replay-attestation-1", "collector-1",
      "recording-ready-2", "replay-attestation-2", "collector-2", "conversation-observer", "supplemental-player",
      "recording-ready-3", "replay-attestation-3", "playback-link-observer", "service-level-sources", "service-levels",
      "collector-3", "provenance-after", "campaign-verifier",
    ]);
    const observer = result.plan.children.find(({ childId }) => childId === "conversation-observer")!;
    expect(observer.environment.DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID)
      .toBe(result.plan.target.botikApplicationId);
    expect(JSON.parse(observer.environment.DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON!))
      .toHaveLength(5);
    expect(result.plan.children.filter(({ entrypoint }) => entrypoint === "actor")).toHaveLength(3);
    expect(result.plan.children.filter(({ entrypoint }) => entrypoint === "recording-ready")).toHaveLength(3);
  });

  it("keeps every generated local path under the owned campaign directory", () => {
    const plan = buildResolvedHostedCampaignPlanV1(definition(), bindings());
    const ownedRoot = "/private/e2e/campaigns/campaign-2026-08-12/";
    const generated = plan.children.flatMap((child) => [
      ...child.produces.map(({ outputPath }) => outputPath),
      ...Object.entries(child.environment)
        .filter(([name]) => name.endsWith("_INPUT") || name.endsWith("_OUTPUT"))
        .map(([, value]) => value)
        .filter((value) => value.startsWith("/private/e2e/campaigns/")),
    ]);
    expect(generated.length).toBeGreaterThan(15);
    expect(generated.every((path) => path.startsWith(ownedRoot))).toBe(true);
    expect(new Set(plan.children.flatMap(({ produces }) => produces.map(({ outputPath }) => outputPath))).size)
      .toBe(plan.children.flatMap(({ produces }) => produces).length);
  });

  it("contains neither commands nor token values and references only an external secret directory", () => {
    const plan = buildResolvedHostedCampaignPlanV1(definition(), bindings());
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('"command"');
    expect(Object.keys(plan.children.flatMap(({ environment }) => Object.keys(environment)))
      .some((name) => name.includes("TOKEN"))).toBe(false);
    expect(serialized).toContain("/run/secrets/discord-e2e");
  });

  it("fails closed for invalid definitions or incomplete/mismatched runtime bindings", () => {
    expect(() => compileHostedCampaignDefinitionV1({ ...definition(), runIds: ["same", "same", "third"] }))
      .toThrow(/unique/u);
    expect(() => buildResolvedHostedCampaignPlanV1(definition(), {
      ...bindings(), runs: bindings().runs.slice(0, 2),
    })).toThrow();
    expect(() => buildResolvedHostedCampaignPlanV1(definition(), {
      ...bindings(), runs: bindings().runs.map((run, index) => index === 1
        ? { ...run, remoteAttestationPath: "/tmp/not-reviewed.json" }
        : run),
    })).toThrow();
  });
});
