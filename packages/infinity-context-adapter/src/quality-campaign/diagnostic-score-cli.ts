import { readFile, writeFile } from "node:fs/promises";
import type { HistoricalIndexPlanV1 } from "@discord-meeting/meeting-core/meeting-knowledge";
import { canonicalJson, sha256 } from "./canonical.js";
import { DiagnosticCustody } from "./diagnostic-custody.js";
import { decodeVersionedDiagnosticManifest } from "./diagnostic-manifest.js";
import { verifyInstalledDiagnosticSdk, type DiagnosticOutcome } from "./diagnostic-run.js";
import { scoreDiagnostic } from "./diagnostic-scoring.js";
/** Separate post-execution entrypoint: execution has no gold-reading capability. */
export async function runDiagnosticScoreCli(argv: readonly string[], writeSafeLine?: (line: string) => void): Promise<0 | 1> {
  if (argv.length !== 5 || argv.slice(1).some(path => !path.startsWith("/"))) {
    return 1;
  }
  try {
    const manifest = decodeVersionedDiagnosticManifest(JSON.parse(await readFile(argv[1]!, "utf8")));
    const installedSdk = manifest.schemaVersion === "meeting_knowledge.real40_diagnostic.v2"
      ? await verifyInstalledDiagnosticSdk(manifest.sdkIdentity) : null;
    const report = JSON.parse(await readFile(argv[2]!, "utf8")) as unknown;
    const loadedModuleSha256 = sha256(await readFile(new URL("./diagnostic-run.js", import.meta.url)));
    const loadedSdkSha256 = installedSdk?.loadedEntrypointSha256 ??
      sha256(await readFile(new URL(import.meta.resolve("@infinity-context/sdk"))));
    const root = sha256({ manifest, loadedModuleSha256, loadedSdkSha256 });
    const key = Buffer.from((await readFile(manifest.connections.artifactKeyPath, "utf8")).trim(), "base64");
    const custody = new DiagnosticCustody(manifest.connections.artifactRoot, key, root);
    const sealed = await custody.recover("execution-complete");
    if (sealed === null || canonicalJson(sealed) !== canonicalJson(report)) {
      throw new Error("diagnostic execution is not complete or report differs");
    }
    // From here on the custody copy is authoritative; the supplied report only
    // selected which sealed execution the operator intended to score.
    const authenticatedReport = sealed;
    const plan = await custody.recover<HistoricalIndexPlanV1>("frozen-plan");
    if (plan === null) {
      throw new Error("diagnostic frozen plan is absent");
    }
    const outcomes: DiagnosticOutcome[] = [];
    for (const question of manifest.questions) {
      const outcome = await custody.recover<DiagnosticOutcome>(`question-${sha256(question.questionId)}`);
      if (outcome === null) {
        throw new Error("diagnostic outcome is absent");
      }
      outcomes.push(outcome);
    }
    if (manifest.schemaVersion === "meeting_knowledge.real40_diagnostic.v2") {
      const authenticationComplete = new Error("diagnostic V2 authentication complete");
      const unopenedGold = new Proxy([], { get(target, property, receiver) {
        if (property === "map") {
          throw authenticationComplete;
        }
        return Reflect.get(target, property, receiver) as unknown;
      } });
      try {
        scoreDiagnostic({ questions: manifest.questions, outcomes, plan, gold: unopenedGold, authentication: {
          manifest, report: authenticatedReport, installedSdkIdentity: installedSdk!, loadedModuleSha256,
        } });
        throw new Error("diagnostic V2 authentication did not stop before gold validation");
      }
      catch (error) {
        if (error !== authenticationComplete) {
          throw error;
        }
      }
    }
    // Gold enters only after authenticated complete execution and all forty outcomes.
    const gold = JSON.parse(await readFile(argv[3]!, "utf8")) as unknown;
    const result = scoreDiagnostic({ questions: manifest.questions, outcomes, plan, gold,
      ...(manifest.schemaVersion === "meeting_knowledge.real40_diagnostic.v2" ? { authentication: {
        manifest, report: authenticatedReport, installedSdkIdentity: installedSdk!, loadedModuleSha256,
      } } : {}) });
    await writeFile(argv[4]!, canonicalJson({ rootBindingSha256: root,
      executionReportSha256: sha256(report), goldSha256: sha256(gold), ...result }), { flag: "wx", mode: 0o600 });
    writeSafeLine?.('{"status":"scored","qualifying":false,"factualAccuracy":"UNMEASURED"}');
    return 0;
  }
  catch {
    writeSafeLine?.('{"status":"blocked","qualifying":false,"reason":"diagnostic_scoring_blocked"}');
    return 1;
  }
}
