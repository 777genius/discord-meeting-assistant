import { exactRecord } from "./canonical.js";
import { createOperatorSafeReceipt, runQualityCampaignOperatorCli, type OperatorExit } from
  "./operator-cli.js";
import { runQualityCampaignProductionComposition } from "./production-composition.js";
import { admitSealedQualificationCorpus } from "./production-corpus-admission.js";
import { createHttpQualityCampaignProductionPorts } from "./production-http-ports.js";
import type { QualityCampaignProductionPorts } from "./production-ports.js";

/** Installed/exported CLI. Dependency injection exists only for deterministic structural tests. */
export async function runQualityCampaignProductionCli(input: { readonly argv: readonly string[];
  readonly ports?: QualityCampaignProductionPorts;
  readonly writeSafeLine?: (line: string) => void }): Promise<OperatorExit> {
  const phasePath = input.argv[1]; const statusPath = input.argv[2];
  if (phasePath === undefined || statusPath === undefined) {return 1;}
  let ports = input.ports;
  return await runQualityCampaignOperatorCli({ argv: [input.argv[0] ?? "", phasePath],
    handlers: { run: async ({ command, phaseInput }) => {
      if (command === "corpus-admit") {
        if (phaseInput.schemaVersion !==
          "meeting_knowledge.semantic_quality_corpus_admission_phase.v1") {
          throw new Error("corpus admission phase input is invalid");
        }
        const admitted = await admitSealedQualificationCorpus(phaseInput.payload);
        return { blockers: [], command, receipt: createOperatorSafeReceipt(
          admitted.campaignRootSha256, { ...admitted }), status: "completed" };
      }
      const phase = exactRecord(phaseInput.payload, ["configurationPath", "connectionsPath"],
        "production phase payload");
      if (phaseInput.schemaVersion !== "meeting_knowledge.semantic_quality_production_phase.v1") {
        throw new Error("production phase input is invalid");
      }
      ports ??= await createHttpQualityCampaignProductionPorts(String(phase.connectionsPath));
      const result = await runQualityCampaignProductionComposition({ command,
        configurationPath: String(phase.configurationPath), ports });
      return { blockers: result.blockerCode === "none" ? [] : [result.blockerCode], command,
        receipt: result.receipt, status: result.status };
    } }, statusReceiptPath: statusPath,
  ...(input.writeSafeLine === undefined ? {} : { writeSafeLine: input.writeSafeLine }) });
}
