import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { hostedServiceLevelsReportV1Schema } from "./collect-hosted-service-levels.js";
import { e2eServiceLevelsV1Schema } from "./e2e-service-levels.js";
import type { HostedCampaignExecutableCompletion } from "./hosted-campaign-coordinator.js";

const completionSchema = z.object({
  campaignId: z.string(), kind: z.literal("hosted-service-levels-completion"),
  measurementCount: z.literal(3), meetingId: z.string(), outputPath: z.string().refine(isAbsolute),
  recordingId: z.string(), reportPath: z.string().refine(isAbsolute), runId: z.string(),
  status: z.literal("ready"),
}).strict();

export async function verifyHostedServiceLevelCompletion(
  output: unknown,
  expected: Extract<HostedCampaignExecutableCompletion, { readonly kind: "service-levels" }>,
): Promise<void> {
  const parsed = completionSchema.parse(output);
  if (parsed.campaignId !== expected.campaignId || parsed.meetingId !== expected.meetingId
    || parsed.outputPath !== expected.outputPath || parsed.recordingId !== expected.recordingId
    || parsed.reportPath !== expected.reportPath || parsed.runId !== expected.runId) {
    throw new Error("Hosted campaign service-levels output correlation mismatch");
  }
  const [serviceLevelsInput, reportInput] = await Promise.all([
    readJson(expected.outputPath), readJson(expected.reportPath),
  ]);
  const serviceLevels = e2eServiceLevelsV1Schema.parse(serviceLevelsInput);
  const report = hostedServiceLevelsReportV1Schema.parse(reportInput);
  if (report.status !== "ready" || report.runId !== expected.runId
    || report.outputCreated !== true || report.measurementCount !== 3) {
    throw new Error("Hosted campaign service-levels report correlation mismatch");
  }
  if (!serviceLevels.measurements.every((measurement) =>
    measurement.start.source.meetingId === expected.meetingId
    && measurement.end.source.meetingId === expected.meetingId
    && measurement.start.source.runId === expected.runId
    && measurement.end.source.runId === expected.runId
  ) || !serviceLevels.measurements.some((measurement) =>
    "recordingId" in measurement.start.source && measurement.start.source.recordingId === expected.recordingId
  ) || !serviceLevels.measurements.some((measurement) =>
    "recordingId" in measurement.end.source && measurement.end.source.recordingId === expected.recordingId
  )) {
    throw new Error("Hosted campaign service-levels artifact correlation mismatch");
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
