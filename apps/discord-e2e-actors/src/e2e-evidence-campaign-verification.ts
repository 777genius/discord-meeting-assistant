import { sameDeploymentProvenance } from "./e2e-evidence-deployment-verification.js";
import { publicationContainerIdentity } from "./e2e-evidence-publication.js";
import type {
  FixtureManifestV1,
  RetainedE2eEvidence,
} from "./e2e-evidence-schema.js";
import type {
  CampaignVerificationResult,
  E2eVerificationResult,
  VerificationFailure,
  VerificationFailureReporter,
} from "./e2e-evidence-verification-types.js";

export interface CampaignVerificationOptions {
  readonly manifest: FixtureManifestV1;
  readonly runs: readonly RetainedE2eEvidence[];
  readonly verifyRun: (
    manifest: FixtureManifestV1,
    evidence: RetainedE2eEvidence,
  ) => E2eVerificationResult;
}

const campaignSchemaPolicy = {
  overlap: { minimumSchemaVersion: 10 },
  reconnect: { minimumSchemaVersion: 10 },
  sequential: { minimumSchemaVersion: 10 },
} as const;

export function verifyCampaign(
  { manifest, runs, verifyRun }: CampaignVerificationOptions,
): CampaignVerificationResult {
  const failures: VerificationFailure[] = [];
  const runResults: Record<string, E2eVerificationResult> = {};
  const fail: VerificationFailureReporter = (code, message) => {
    failures.push({ code, message });
  };
  for (const run of runs) {
    if (runResults[run.actorRun.runId] !== undefined) {
      fail("DUPLICATE_RUN_ID", `run ID ${run.actorRun.runId} appears more than once`);
      continue;
    }
    const verification = verifyRun(manifest, run);
    runResults[run.actorRun.runId] = verification;
    if (!verification.passed) {
      fail("RUN_FAILED", `run ${run.actorRun.runId} failed evidence verification`);
    }
  }
  verifyRequiredScenarios(runs, fail);
  verifyPostCallScenarioSchemaMinima(runs, fail);
  verifyCurrentVoiceQualification(runs, fail);
  verifyCampaignIsolation(runs, fail);
  verifyCampaignDeploymentProvenance(runs, fail);
  return {
    failures: Object.freeze(failures),
    passed: failures.length === 0,
    runResults: Object.freeze(runResults),
  };
}

function verifyCurrentVoiceQualification(
  runs: readonly RetainedE2eEvidence[],
  fail: VerificationFailureReporter,
): void {
  const current = runs.filter((run) => run.schemaVersion === 10);
  if (current.length !== runs.length) {
    fail(
      "CURRENT_CAMPAIGN_SCHEMA_REQUIRED",
      "campaign qualification requires every run to use retained evidence schema v10",
    );
    return;
  }
  const voice = current.filter((run) => run.qualificationKind === "voice");
  if (voice.length !== 1 || voice[0]?.actorRun.scenario !== "reconnect") {
    fail("CURRENT_VOICE_PROOF_MISSING", "campaign requires one V10 reconnect voice qualification");
  }
  const releaseBindings = new Set(current.map((run) => JSON.stringify(run.release)));
  if (releaseBindings.size !== 1) {
    fail("CAMPAIGN_RELEASE_CHANGED", "release binding changed between current campaign runs");
  }
  const policies = new Set(current.map((run) => run.qualificationPolicy.policySha256));
  if (policies.size !== 1) {
    fail("CAMPAIGN_LATENCY_POLICY_CHANGED", "governed latency policy changed between campaign runs");
  }
  const durability = new Set(current.map((run) => run.durabilityQualification.artifactSha256));
  if (durability.size !== 1) {
    fail("CAMPAIGN_DURABILITY_PROOF_CHANGED", "durability proof changed between campaign runs");
  }
}

function verifyPostCallScenarioSchemaMinima(
  runs: readonly RetainedE2eEvidence[],
  fail: VerificationFailureReporter,
): void {
  for (const scenario of ["sequential", "overlap"] as const) {
    const scenarioRuns = runs.filter(({ actorRun }) => actorRun.scenario === scenario);
    if (
      scenarioRuns.length > 0 &&
      !scenarioRuns.some(({ schemaVersion }) =>
        schemaVersion >= campaignSchemaPolicy[scenario].minimumSchemaVersion
      )
    ) {
      fail(
        "SCENARIO_SCHEMA_TOO_OLD",
        `${scenario} campaign proof requires retained evidence schema v${campaignSchemaPolicy[scenario].minimumSchemaVersion} or newer`,
      );
    }
  }
}

function verifyRequiredScenarios(
  runs: readonly RetainedE2eEvidence[],
  fail: VerificationFailureReporter,
): void {
  for (const scenario of ["sequential", "overlap", "reconnect"] as const) {
    if (!runs.some(({ actorRun }) => actorRun.scenario === scenario)) {
      fail("SCENARIO_NOT_PROVEN", `campaign has no passing ${scenario} run`);
    }
  }
}

function verifyCampaignIsolation(
  runs: readonly RetainedE2eEvidence[],
  fail: VerificationFailureReporter,
): void {
  const identities: ReadonlyArray<readonly [string, (run: RetainedE2eEvidence) => string]> = [
    ["meeting", (run) => run.meetingId],
    ["recording", (run) => run.recording.recordingId],
    ["transcript", (run) => run.transcript.transcriptId],
    ["summary", (run) => run.summary.summaryId],
    ["message", (run) => run.publication.messageId],
  ];
  for (const [kind, select] of identities) {
    const values = runs.map(select);
    if (new Set(values).size !== values.length) {
      fail("CAMPAIGN_STATE_LEAK", `${kind} identity is shared by independent runs`);
    }
  }
  const threadContainers = runs
    .filter((run) => isThreadPublication(run.publication))
    .map((run) => publicationContainerIdentity(run.publication));
  if (new Set(threadContainers).size !== threadContainers.length) {
    fail("CAMPAIGN_STATE_LEAK", "thread publication container is shared by independent runs");
  }
}

function isThreadPublication(publication: RetainedE2eEvidence["publication"]): boolean {
  return "threadId" in publication || publication.container.kind === "thread";
}

function verifyCampaignDeploymentProvenance(
  runs: readonly RetainedE2eEvidence[],
  fail: VerificationFailureReporter,
): void {
  const baseline = runs[0];
  if (baseline === undefined) {
    return;
  }
  for (const run of runs.slice(1)) {
    if (!sameDeploymentProvenance(baseline.deployment, run.deployment)) {
      fail(
        "CAMPAIGN_DEPLOYMENT_CHANGED",
        "immutable deployment provenance changed between campaign runs",
      );
    }
  }
}
