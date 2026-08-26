import type { RetainedE2eEvidence } from "./e2e-evidence-schema.js";
import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";
import {
  thinRemediationProofV1Schema,
  type ThinRemediationProofV1,
} from "./thin-remediation-proof.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-target.js";

export function verifyThinRemediationCampaignEvidence(
  value: ThinRemediationProofV1,
  runs: readonly RetainedE2eEvidence[],
  fail: VerificationFailureReporter,
): void {
  if (!thinRemediationProofV1Schema.safeParse(value).success) {
    fail("THIN_REMEDIATION_INVALID", "remediation bundle is malformed or inconclusive");
    return;
  }
  const reconnect = runs.find(({ actorRun }) => actorRun.scenario === "reconnect");
  if (runs.some((run) => run.schemaVersion !== 10 ||
    JSON.stringify(run.release) !== JSON.stringify(value.release))) {
    fail("THIN_REMEDIATION_RELEASE_MISMATCH", "remediation bundle is not bound to every V10 release");
  }
  if (reconnect === undefined || reconnect.actorRun.runId !== value.runId ||
    reconnect.meetingId !== value.artifacts.greetingLedger.content.meetingId ||
    reconnect.meetingId !== value.artifacts.liveMemory.content.final.event.meetingId ||
    reconnect.meetingId !== value.artifacts.privateCoverage.content.meetingId ||
    value.artifacts.privateCoverage.content.privateTestGuildId !== HOSTED_CAMPAIGN_TARGET.guildId ||
    value.artifacts.privateCoverage.content.observerActorId !==
      HOSTED_CAMPAIGN_TARGET.observerApplicationId ||
    value.artifacts.privateCoverage.content.sutActorId !== HOSTED_CAMPAIGN_TARGET.sutApplicationId) {
    fail("THIN_REMEDIATION_RUN_MISMATCH", "remediation children do not bind the exact reconnect meeting and run");
  }
}
