import { z } from "zod";
import { findOssTestContainer, inventoryQuery, runOssReadCommand, type OssReadCommand } from "./oss-readonly-collection.js";
import { imageProvenanceFormat } from "./ssh-deployment-probe-scripts.js";
import { requireEvidence as check, sha256 } from "./oss-campaign-artifacts.js";
import { id, digest, revision, time, planSchema, type OssPlan } from "./oss-campaign-profile.js";

export const nativeDeploymentSchema = z.object({ kind: z.literal("oss-native-deployment-v1"),
  phase: z.enum(["before", "after"]), project: z.literal("vtoss-test-oss-8f49a06-r1"),
  startedAtMs: time, completedAtMs: time, recordingIds: z.array(id).max(3),
  services: z.array(z.object({ service: id, containerId: z.string().regex(/^[a-f0-9]{12,64}$/u),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u), sourceRevision: revision }).strict()).length(3),
  config: z.object({ gatewayEndpointSha256: digest, operatorCaSha256: digest, operatorCaBase64: z.string().max(100000),
    guildId: id, voiceChannelId: id, resultsChannelId: id, applicationId: id,
    summaryProvider: z.literal("transcript-outline"), conversationEnabled: z.literal("false"), liveEnabled: z.literal("true"),
  }).strict(),
}).strict();
const configScript = String.raw`
import { readFile } from "node:fs/promises";
import { createHash, X509Certificate } from "node:crypto";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const ca = await readFile(process.env.NODE_EXTRA_CA_CERTS);
if (ca.length > 65536 || !/^(?:-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*)+$/u.test(ca.toString("utf8"))) throw new Error("OSS public CA required");
new X509Certificate(ca);
console.log(JSON.stringify({ gatewayEndpointSha256: hash(process.env.VOICETEXT_WS_URL),
 operatorCaSha256: hash(ca), operatorCaBase64: ca.toString("base64"),
 guildId: process.env.DISCORD_LEGACY_GUILD_ID, voiceChannelId: process.env.DISCORD_LEGACY_VOICE_CHANNEL_ID,
 resultsChannelId: process.env.DISCORD_RESULTS_CHANNEL_ID, applicationId: process.env.DISCORD_APPLICATION_ID,
 summaryProvider: process.env.SUMMARY_PROVIDER, conversationEnabled: process.env.CONVERSATION_ENABLED,
 liveEnabled: process.env.VOICETEXT_LIVE_ENABLED }));
`;

export async function collectOssDeployment(input: {
  plan: OssPlan; phase: "before" | "after"; command?: OssReadCommand;
}) {
  const plan = planSchema.parse(input.plan), run = input.command ?? runOssReadCommand;
  const startedAtMs = Date.now();
  const services = [];
  for (const [service, expectedRevision] of [[plan.target.platformService, plan.target.platformRevision],
    [plan.target.craigService, plan.target.craigRevision], ["voicetext-gateway", plan.target.gatewayRevision]]) {
    const containerId = await findOssTestContainer(plan, run, service!);
    const imageId = (await run(["inspect", "--format", "{{.Image}}", containerId])).trim();
    check(/^sha256:[a-f0-9]{64}$/u.test(imageId), "Invalid native deployment image");
    const image = z.object({ sourceRevision: revision }).parse(JSON.parse(await run([
      "image", "inspect", "--format", imageProvenanceFormat, imageId,
    ])));
    check(image.sourceRevision === expectedRevision, "Native deployment source revision mismatch");
    services.push({ service: service!, containerId, imageId, sourceRevision: image.sourceRevision });
  }
  const postgres = await findOssTestContainer(plan, run, "postgres");
  const recordingIds = z.array(id).max(3).parse(JSON.parse(await run(["exec", postgres, "sh", "-c",
    'exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"', "oss-readonly",
    `BEGIN READ ONLY; SET LOCAL statement_timeout='10000'; ${inventoryQuery} COMMIT;`,
  ])));
  check(recordingIds.length === (input.phase === "before" ? 0 : 3), "Native project inventory does not match campaign phase");
  const config = nativeDeploymentSchema.shape.config.parse(JSON.parse(await run([
    "exec", services[0]!.containerId, "node", "--input-type=module", "-e", configScript,
  ])));
  check(config.gatewayEndpointSha256 === sha256(plan.target.gatewayEndpoint) && config.operatorCaSha256 === plan.target.operatorCaSha256 &&
    sha256(Buffer.from(config.operatorCaBase64, "base64")) === config.operatorCaSha256 &&
    config.guildId === plan.target.guildId && config.voiceChannelId === plan.target.voiceChannelId &&
    config.resultsChannelId === plan.target.resultsChannelId && config.applicationId === plan.target.publicationApplicationId,
    "Native deployment public configuration mismatch");
  return nativeDeploymentSchema.parse({ kind: "oss-native-deployment-v1", phase: input.phase, project: plan.target.project,
    startedAtMs, completedAtMs: Date.now(), recordingIds, services, config });
}
