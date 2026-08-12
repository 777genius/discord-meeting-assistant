import { publishNewConversationVoiceTurnIdFile } from "./conversation-voice-turn-id-source.js";

async function main(): Promise<void> {
  const [path, turnId, ...unexpected] = process.argv.slice(2);
  if (path === undefined || turnId === undefined || unexpected.length > 0) {
    throw new Error("Usage: publish:conversation-turn-id -- <absolute-path> <turn-id>");
  }
  await publishNewConversationVoiceTurnIdFile({ path, turnId });
  process.stdout.write(`${JSON.stringify({ path, status: "published" })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Turn ID publication failed"}\n`);
  process.exitCode = 1;
});
