import { createHash } from "node:crypto";

import { parseLastJsonLine } from "./ssh-deployment-probe-commands.js";
import {
  historicalReplyQuestionOutcomeQuery,
  historicalReplyQuestionAdmissionQuery,
  historicalReplyRehydrationQuery,
  historicalReplySettlementQuery,
} from "./ssh-deployment-probe-scripts.js";
import {
  correlationId,
  historicalReplyQuestionOutcomeOutputSchema,
  historicalReplyQuestionAdmissionOutputSchema,
  historicalReplyRehydrationOutputSchema,
  historicalReplySettlementOutputSchema,
} from "./ssh-deployment-probe-validation.js";
import type { DeployedServiceProvenance } from "./e2e-evidence.js";

interface HistoricalReplyProbePorts {
  readonly collectService: () => Promise<DeployedServiceProvenance>;
  readonly collectWorkerProcess: () => Promise<{ readonly containerId: string; readonly hostProcessId: number }>;
  readonly dockerExecPostgres: (arguments_: readonly string[]) => Promise<string>;
}

const psql = (query: string): readonly string[] => [
  "psql", "--no-psqlrc", "-U", "meeting", "-d", "meeting", "-At", "-c", query,
];

export async function collectHistoricalReplyReadiness(
  ports: HistoricalReplyProbePorts,
  meetingId: string,
) {
  const validated = correlationId.parse(meetingId);
  const [service, worker, output] = await Promise.all([
    ports.collectService(),
    ports.collectWorkerProcess(),
    ports.dockerExecPostgres(psql(
      historicalReplyRehydrationQuery.replaceAll("__MEETING_ID__", validated),
    )),
  ]);
  const rehydration = historicalReplyRehydrationOutputSchema.parse(parseLastJsonLine(output));
  if (worker.containerId !== service.containerId) {
    throw new Error("Historical reply worker process changed during readiness inspection");
  }
  if (service.repositoryDigest === null) {
    throw new Error("Historical reply service image lacks an immutable repository digest");
  }
  return Object.freeze({
    rehydration: Object.freeze({ ...rehydration, serviceContainerId: service.containerId }),
    service: Object.freeze({
      composeConfigHash: service.composeConfigHash,
      composeProject: service.composeProject,
      composeService: service.composeService,
      containerId: service.containerId,
      hostProcessId: worker.hostProcessId,
      imageId: service.imageId,
      repositoryDigest: service.repositoryDigest,
      sourceRevision: service.sourceRevision,
      startedAt: service.containerStartedAt,
    }),
  });
}

export async function collectHistoricalReplyQuestionOutcome(
  ports: HistoricalReplyProbePorts,
  questionId: string,
) {
  const validated = correlationId.parse(questionId);
  const [service, output] = await Promise.all([
    ports.collectService(),
    ports.dockerExecPostgres(psql(
      historicalReplyQuestionOutcomeQuery.replaceAll("__QUESTION_ID__", validated),
    )),
  ]);
  return Object.freeze({
    ...historicalReplyQuestionOutcomeOutputSchema.parse(parseLastJsonLine(output)),
    serviceContainerId: service.containerId,
  });
}

export async function collectHistoricalReplyQuestionAdmission(
  ports: HistoricalReplyProbePorts,
  questionId: string,
) {
  const validated = correlationId.parse(questionId);
  const [service, output] = await Promise.all([
    ports.collectService(),
    ports.dockerExecPostgres(psql(
      historicalReplyQuestionAdmissionQuery.replaceAll("__QUESTION_ID__", validated),
    )),
  ]);
  const parsed = historicalReplyQuestionAdmissionOutputSchema.parse(parseLastJsonLine(output));
  const { groundingPlanCanonicalJson, ...admission } = parsed;
  return Object.freeze({
    ...admission,
    groundingPlanSha256: createHash("sha256").update(groundingPlanCanonicalJson, "utf8").digest("hex"),
    serviceContainerId: service.containerId,
  });
}

export async function collectHistoricalReplySettlement(
  ports: HistoricalReplyProbePorts,
  questionId: string,
) {
  const validated = correlationId.parse(questionId);
  const [service, worker, output] = await Promise.all([
    ports.collectService(),
    ports.collectWorkerProcess(),
    ports.dockerExecPostgres(psql(
      historicalReplySettlementQuery.replaceAll("__QUESTION_ID__", validated),
    )),
  ]);
  if (worker.containerId !== service.containerId) {
    throw new Error("Historical reply worker process changed during settlement inspection");
  }
  const parsed = historicalReplySettlementOutputSchema.parse(parseLastJsonLine(output));
  const { groundingPlanCanonicalJson, ...settlement } = parsed;
  return Object.freeze({
    ...settlement,
    groundingPlanSha256: createHash("sha256").update(groundingPlanCanonicalJson, "utf8").digest("hex"),
    serviceHostProcessId: worker.hostProcessId,
    serviceContainerId: service.containerId,
  });
}
