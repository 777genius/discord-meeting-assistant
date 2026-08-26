import { z } from "zod";

import type { CraigCampaignStackInput } from "./craig-disposable-campaign-stack.js";

const containerId = z.string().regex(/^[a-f\d]{64}$/u);
const imageId = z.string().regex(/^sha256:[a-f\d]{64}$/u);
const repositoryDigest = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);

export function validateCraigRuntime(
  text: string,
  input: CraigCampaignStackInput,
  projectName: string,
  id: string,
): void {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Craig runtime inspection is not JSON"); }
  const parsed = z.array(z.object({ Id: containerId, Image: imageId,
    Config: z.object({ Env: z.array(z.string()), Image: repositoryDigest,
      Labels: z.record(z.string(), z.string()) }).loose(),
    State: z.object({ Health: z.object({ Status: z.literal("healthy") }).loose(),
      Running: z.literal(true) }).loose(),
  }).loose()).length(1).parse(value)[0]!;
  const environment = Object.fromEntries(parsed.Config.Env.map((entry) => {
    const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)];
  }));
  const labels = parsed.Config.Labels;
  if (parsed.Id !== id || parsed.Image !== input.serviceIdentity.imageId
    || parsed.Config.Image !== input.serviceIdentity.repositoryDigest
    || labels["com.docker.compose.project"] !== projectName
    || labels["com.docker.compose.service"] !== input.service
    || environment.E2E_CAMPAIGN_ID !== input.campaignId
    || environment.E2E_SOURCE_REVISION !== input.serviceIdentity.sourceRevision
    || environment.DISCORD_APPLICATION_ID !== input.serviceIdentity.applicationId) {
    throw new Error("Craig runtime container identity does not match the staged plan");
  }
}
