import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collectOssDeployment } from "../src/oss-deployment-collection.js";
import { sha256 } from "../src/oss-campaign-artifacts.js";
import { campaignFixture } from "./oss-campaign-fixture.js";

it("collects deployment revisions and initial inventory through readonly commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "oss-deployment-test-"));
  try {
    const { plan } = await campaignFixture(root);
    const services = [plan.target.platformService, plan.target.craigService, "voicetext-gateway", "postgres"];
    const revisions = [plan.target.platformRevision, plan.target.craigRevision, plan.target.gatewayRevision];
    const ids = services.map((_service, index) => String(index + 1).repeat(12));
    const imageIds = services.map((_service, index) => `sha256:${String(index + 1).repeat(64)}`);
    const calls: string[][] = [];
    let inventory: string[] = [];
    const command = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "ps") return ids[services.findIndex((service) => args.includes(`label=com.docker.compose.service=${service}`))]!;
      if (args[0] === "image") return JSON.stringify({ sourceRevision: revisions[imageIds.indexOf(args.at(-1)!)] });
      if (args[0] === "inspect") {
        const index = ids.indexOf(args.at(-1)!);
        if (args[2] === "{{.Image}}") return imageIds[index]!;
        if (args[2] === "{{.State.Health.Status}}") return "healthy";
        return JSON.stringify({ composeProject: plan.target.project, composeService: services[index], testOnly: index === 0 ? "true" : null });
      }
      if (args.includes("oss-readonly")) return JSON.stringify(inventory);
      return JSON.stringify({ gatewayEndpointSha256: sha256(plan.target.gatewayEndpoint), operatorCaSha256: plan.target.operatorCaSha256,
        operatorCaBase64: Buffer.from("offline-public-ca").toString("base64"), guildId: plan.target.guildId,
        voiceChannelId: plan.target.voiceChannelId, resultsChannelId: plan.target.resultsChannelId, applicationId: plan.target.publicationApplicationId,
        summaryProvider: "transcript-outline", conversationEnabled: "false", liveEnabled: "true" });
    };
    const result = await collectOssDeployment({ plan, phase: "before", command });
    expect(result.recordingIds).toEqual([]);
    expect(result.services.map((service) => service.sourceRevision)).toEqual(revisions);
    expect(calls.some((args) => args.at(-1)?.startsWith("BEGIN READ ONLY;"))).toBe(true);
    expect(calls.flat().join(" ")).not.toMatch(/collect:e2e|replayJob|INSERT|UPDATE|DELETE/u);
    inventory = ["unexpected"];
    await expect(collectOssDeployment({ plan, phase: "before", command })).rejects.toThrow("inventory");
  } finally { await rm(root, { recursive: true }); }
});
