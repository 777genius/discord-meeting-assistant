import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { RecordingIngressError } from "./errors.js";

export async function terminalReceiptTokens(
  directory: string,
  parseReceipt: (value: unknown) => { readonly recordingId: string },
  tokenForRecording: (recordingId: string) => string,
): Promise<Set<string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const tokens = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f\d]{64}\.json$/u.test(entry.name)) {
      continue;
    }
    let parsed: { readonly recordingId: string };
    try {
      parsed = parseReceipt(JSON.parse(await readFile(join(directory, entry.name), "utf8")));
    } catch (error) {
      if (error instanceof RecordingIngressError) {
        throw error;
      }
      throw new RecordingIngressError("corrupt-spool", "terminal receipt is invalid JSON", {
        cause: error,
      });
    }
    const token = entry.name.slice(0, -".json".length);
    if (token !== tokenForRecording(parsed.recordingId)) {
      throw new RecordingIngressError("corrupt-spool", "terminal receipt path does not match recording");
    }
    tokens.add(token);
  }
  return tokens;
}
