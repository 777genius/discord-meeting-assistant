import { parseLastJsonLine } from "./ssh-deployment-probe-commands.js";
import {
  greetingLedgerRowsQuery,
  historicalReplyWorkerProcessFormat,
  liveMemoryRowsQuery,
} from "./ssh-deployment-probe-scripts.js";
import {
  correlationId,
  greetingLedgerRowsOutputSchema,
  historicalReplyWorkerProcessOutputSchema,
  liveMemoryRowsOutputSchema,
  recordingStartedAtSchema,
} from "./ssh-deployment-probe-validation.js";
import {
  collectHistoricalReplyQuestionOutcome,
  collectHistoricalReplyQuestionAdmission,
  collectHistoricalReplyReadiness,
  collectHistoricalReplySettlement,
} from "./ssh-deployment-probe-historical-reply.js";
import type { DeployedServiceProvenance } from "./e2e-evidence.js";

export interface QualificationProbePorts {
  readonly collectService: () => Promise<DeployedServiceProvenance>;
  readonly dockerExecPostgres: (arguments_: readonly string[]) => Promise<string>;
  readonly findMeetingPlatformContainerId: () => Promise<string>;
  readonly restartMeetingPlatform: () => Promise<string>;
  readonly runRemote: (arguments_: readonly string[]) => Promise<string>;
}

const psql = (query: string): readonly string[] =>
  ["psql", "--no-psqlrc", "-U", "meeting", "-d", "meeting", "-At", "-c", query];

const worker = async (ports: QualificationProbePorts) => {
  const containerId = await ports.findMeetingPlatformContainerId();
  return historicalReplyWorkerProcessOutputSchema.parse(parseLastJsonLine(await ports.runRemote([
    "docker", "inspect", "--format", historicalReplyWorkerProcessFormat, containerId,
  ])));
};

const historicalPorts = (ports: QualificationProbePorts) => ({
  collectService: ports.collectService,
  collectWorkerProcess: () => worker(ports),
  dockerExecPostgres: ports.dockerExecPostgres,
});

export const collectQualificationHistoricalReadiness = (ports: QualificationProbePorts, meetingId: string) =>
  collectHistoricalReplyReadiness(historicalPorts(ports), meetingId);
export const collectQualificationQuestionOutcome = (ports: QualificationProbePorts, questionId: string) =>
  collectHistoricalReplyQuestionOutcome(historicalPorts(ports), questionId);
export const collectQualificationSettlement = (ports: QualificationProbePorts, questionId: string) =>
  collectHistoricalReplySettlement(historicalPorts(ports), questionId);

export async function collectQualificationGreetingRows(
  ports: QualificationProbePorts,
  receiptIds: readonly [string, string, string, string],
) {
  if (receiptIds.some((receiptId) => !/^[a-f\d]{64}$/u.test(receiptId)) ||
    new Set(receiptIds).size !== receiptIds.length) {
    throw new Error("Greeting ledger inspection requires four unique SHA-256 receipt identities");
  }
  const values = receiptIds.map((receiptId, index) =>
    `('${receiptId}', ${String(index + 1)})`).join(", ");
  const output = await ports.dockerExecPostgres(psql(
    greetingLedgerRowsQuery.replace("__GREETING_RECEIPTS__", values),
  ));
  return greetingLedgerRowsOutputSchema.parse(parseLastJsonLine(output));
}

export async function collectQualificationLiveRows(ports: QualificationProbePorts, meetingId: string) {
  const validated = correlationId.parse(meetingId);
  const output = await ports.dockerExecPostgres(psql(
    liveMemoryRowsQuery.replaceAll("__MEETING_ID__", validated),
  ));
  return liveMemoryRowsOutputSchema.parse(parseLastJsonLine(output));
}

export function collectQualificationHistoricalAdmission(
  ports: QualificationProbePorts,
  questionId: string,
) {
  return collectHistoricalReplyQuestionAdmission(historicalPorts(ports), questionId);
}

export async function collectQualificationLogs(ports: QualificationProbePorts, since: string): Promise<string> {
  const containerId = await ports.findMeetingPlatformContainerId();
  return ports.runRemote(["docker", "logs", "--since", recordingStartedAtSchema.parse(since), containerId]);
}

export const collectQualificationWorker = worker;
