import { readFile } from "node:fs/promises";

import { GrpcSubscriptionRuntimeTransport } from "@discord-meeting/subscription-runtime-adapter";

const tokenPath = process.env.SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE;
if (tokenPath === undefined || tokenPath.length === 0) {
  throw new Error("SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE is required");
}

const serviceToken = (await readFile(tokenPath, "utf8")).trim();
const transport = new GrpcSubscriptionRuntimeTransport({
  address: "127.0.0.1:50052",
  serviceToken,
});
try {
  const health = await transport.checkHealth();
  if (health.status !== "serving") {
    throw new Error(`subscription runtime is ${health.status}`);
  }
} finally {
  transport.close();
}
