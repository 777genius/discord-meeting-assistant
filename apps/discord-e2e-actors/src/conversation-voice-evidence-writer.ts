import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";

import {
  ConversationVoiceCaptureError,
  type ConversationVoiceEvidence,
} from "./conversation-voice-capture-types.js";

export async function assertConversationVoiceEvidencePathIsNew(outputPath: string): Promise<void> {
  try {
    await lstat(outputPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  throw new ConversationVoiceCaptureError(
    "output-exists",
    "Conversation voice observer output already exists and will not be replaced",
  );
}

export async function writeNewConversationVoiceEvidenceAtomically(
  outputPath: string,
  evidence: ConversationVoiceEvidence,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  let temporaryHandle: FileHandle | undefined;
  let published = false;
  try {
    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(evidence, undefined, 2)}\n`, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await chmod(temporaryPath, 0o600);
    await link(temporaryPath, outputPath);
    published = true;
    await unlink(temporaryPath).catch(() => {});
  } catch (error) {
    await temporaryHandle?.close().catch(() => {});
    if (!published) {
      await unlink(temporaryPath).catch(() => {});
    }
    if (isOutputCollisionError(error)) {
      throw new ConversationVoiceCaptureError(
        "output-exists",
        "Conversation voice observer output already exists and will not be replaced",
        { cause: error },
      );
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isOutputCollisionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
