import type { PlatformConfig } from "../config.js";
import { OssPostCallEvidence } from "./oss-post-call-evidence.js";
import { OssNativeEvidenceJournal } from "@discord-meeting/voicetext-adapter";
import type { PlatformStartupCleanup } from "./startup-cleanup.js";

export interface OssPlatformEvidence {
  readonly live: OssNativeEvidenceJournal;
  readonly postCall: OssPostCallEvidence;
  abort(): void;
  close(): Promise<void>;
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
  // Register before constructing the post-call tap so partial startup still drains
  // the live writer. One coordinated callback prevents a premature post-call seal.
  let postCall: OssPostCallEvidence | undefined;
  let closing: Promise<void> | undefined;
  let aborted = false;
  const abort = (): void => { aborted = true; journal.abort(); };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        await journal.close(() => {
          if (aborted) { throw new Error("OSS native evidence aborted"); }
          postCall?.seal();
        });
      } catch (error) { abort(); throw error; }
    })();
    return closing;
  };
  cleanup.defer("OSS native evidence close", () => {
    // Invalidate before the startup coordinator bounds descriptor cleanup. A
    // timeout or another cleanup rejection cannot leave a publishable writer.
    abort();
    return close();
  });
  postCall = new OssPostCallEvidence(directory, environment.OSS_STT_NATIVE_EVIDENCE_REVISION!);
  return { live: journal, postCall, abort, close };
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
