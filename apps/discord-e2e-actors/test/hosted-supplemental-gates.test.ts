import { describe, expect, it } from "vitest";

import {
  HOSTED_CAMPAIGN_TARGET,
  validateHostedCampaign,
  type HostedCampaignExecutableSpec,
  type HostedCampaignInput,
} from "../src/hosted-campaign-coordinator.js";
import { parseHostedCampaignPlan } from "../src/hosted-campaign-run-config.js";

const reconnect = { campaignId: "campaign-1", ordinal: 3, retainedCaptureCount: 6,
  runId: "run-3", scenario: "reconnect" as const };
const trigger = (ordinal: 3 | 4) => ({
  action: { kind: "capture-retained" as const, ordinal }, ordinal: 3, runId: "run-3",
});
const supplemental = (): HostedCampaignExecutableSpec => ({
  arguments: { kind: "environment" }, childId: "supplemental", completion: {
    action: { kind: "supplemental-completed", ordinal: 3, runId: "run-3" },
    kind: "supplemental-player", outputPath: "/evidence/supplemental.json", runId: "run-3",
  }, entrypoint: "supplemental-player", environment: {
    DISCORD_E2E_SUPPLEMENTAL_CAMPAIGN_ID: "campaign-1",
    DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_PATH: "/gates/connection.json",
    DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_ARMED_PATH: "/gates/connection.armed.json",
    DISCORD_E2E_SUPPLEMENTAL_GATE_TIMEOUT_MS: "30000",
    DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_PATH: "/gates/playback.json",
    DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_ARMED_PATH: "/gates/playback.armed.json",
    DISCORD_E2E_SUPPLEMENTAL_RUN_ID: "run-3",
  }, produces: [{ action: { kind: "supplemental-completed", ordinal: 3, runId: "run-3" },
    ordinal: 3, outputPath: "/barriers/supplemental.json", runId: "run-3" }], requires: [],
  startBefore: { action: { kind: "capture-retained", ordinal: 1 }, kind: "barrier", ordinal: 3, runId: "run-3" },
  supplementalGates: {
    connection: { armedPath: "/gates/connection.armed.json", path: "/gates/connection.json", trigger: trigger(3) },
    playback: { armedPath: "/gates/playback.armed.json", path: "/gates/playback.json", trigger: trigger(4) },
  },
});
const input = (child: HostedCampaignExecutableSpec): HostedCampaignInput => ({
  children: [child], runs: [
    { campaignId: "campaign-1", ordinal: 1, retainedCaptureCount: 0, runId: "run-1", scenario: "sequential" },
    { campaignId: "campaign-1", ordinal: 2, retainedCaptureCount: 0, runId: "run-2", scenario: "overlap" }, reconnect,
  ], target: HOSTED_CAMPAIGN_TARGET, thresholds: { answerFirstPacketMilliseconds: 4_000 },
});

describe("hosted supplemental two-phase gate contract", () => {
  it("parses exact reconnect capture-3/capture-4 triggers", () => {
    expect(parseHostedCampaignPlan(input(supplemental())).children[0]?.supplementalGates)
      .toEqual(supplemental().supplementalGates);
  });

  it("rejects wrong entrypoint, trigger, path, campaign, run, or timeout binding", () => {
    const candidates: HostedCampaignExecutableSpec[] = [
      { ...supplemental(), entrypoint: "actor" },
      { ...supplemental(), supplementalGates: { ...supplemental().supplementalGates!, connection: {
        ...supplemental().supplementalGates!.connection, trigger: trigger(4),
      } } },
      { ...supplemental(), supplementalGates: { connection: supplemental().supplementalGates!.connection,
        playback: { ...supplemental().supplementalGates!.playback, path: "/gates/connection.json" } } },
      { ...supplemental(), environment: { ...supplemental().environment,
        DISCORD_E2E_SUPPLEMENTAL_CAMPAIGN_ID: "other" } },
      { ...supplemental(), environment: { ...supplemental().environment,
        DISCORD_E2E_SUPPLEMENTAL_RUN_ID: "run-2" } },
      { ...supplemental(), environment: { ...supplemental().environment,
        DISCORD_E2E_SUPPLEMENTAL_GATE_TIMEOUT_MS: "999" } },
    ];
    for (const child of candidates) {
      expect(() => validateHostedCampaign(input(child))).toThrow(/supplemental|entrypoint/u);
    }
  });
});
