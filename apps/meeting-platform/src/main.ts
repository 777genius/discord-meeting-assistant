import { loadPlatformConfig } from "./config.js";
import { startMeetingPlatform } from "./platform-runtime.js";

const config = await loadPlatformConfig();
const runtime = await startMeetingPlatform(config);
let shuttingDown = false;

const shutdown = async (): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    await runtime.close();
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
