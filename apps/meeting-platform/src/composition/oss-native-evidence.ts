import type { PlatformConfig } from "../config.js";
import { OssPostCallEvidence } from "./oss-post-call-evidence.js";
import { OssNativeEvidenceJournal } from "@discord-meeting/voicetext-adapter";
import type { PlatformStartupCleanup } from "./startup-cleanup.js";

export interface OssPlatformEvidence {
  readonly live: OssNativeEvidenceJournal;
  readonly postCall: OssPostCallEvidence;
  seal(): void;
}

/** Explicit TEST-only admission; absent directory leaves normal runtime unchanged. */
export function createOssNativeEvidence(
  cleanup: PlatformStartupCleanup,
  environment: NodeJS.ProcessEnv = process.env,
): OssPlatformEvidence | undefined {
  const directory = environment.OSS_STT_NATIVE_EVIDENCE_DIRECTORY;
  if (directory === undefined) { return undefined; }
  if (environment.CONVERSATION_ENABLED !== "false" ||
    environment.SUMMARY_PROVIDER !== "transcript-outline") {
    throw new Error("OSS native capture requires conversation disabled and transcript-outline");
  }
  const journal = new OssNativeEvidenceJournal({
    directory,
    project: environment.OSS_STT_NATIVE_EVIDENCE_PROJECT ?? "",
    revision: environment.OSS_STT_NATIVE_EVIDENCE_REVISION ?? "",
    testOnly: environment.E2E_TEST_ONLY_LABEL === "true"
  });
  cleanup.defer("OSS native evidence seal", () => { journal.seal(); });
  const postCall = new OssPostCallEvidence(directory, environment.OSS_STT_NATIVE_EVIDENCE_REVISION!);
  cleanup.defer("OSS post-call evidence seal", () => { postCall.seal(); });
  return {
    live: journal, postCall, seal: () => {
      const failures: unknown[] = [];
      for (const capture of [journal, postCall]) {
        try { capture.seal(); } catch (error) { failures.push(error); }
      }
      if (failures.length) { throw new AggregateError(failures, "OSS capture sealing failed"); }
    }
  };
}

export function hasLiveTranscriptionConfiguration(
  config: PlatformConfig,
): config is PlatformConfig & {
  readonly voicetext: NonNullable<PlatformConfig["voicetext"]>;
  readonly secrets: PlatformConfig["secrets"] & {
    readonly voicetextServiceToken: string;
  };
} {
  return (
    config.transcriptionProvider === "voicetext" &&
    config.voicetext !== undefined &&
    config.voicetext.liveEnabled === true &&
    config.secrets.voicetextServiceToken !== undefined
  );
}
