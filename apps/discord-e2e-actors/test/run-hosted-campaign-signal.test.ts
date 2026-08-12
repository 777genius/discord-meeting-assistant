import { describe, expect, it } from "vitest";

import { HostedCampaignInterruptedError } from "../src/run-hosted-campaign.js";

describe("run-hosted-campaign signal exit contract", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("maps %s to the conventional process exit code", (signal, exitCode) => {
    const error = new HostedCampaignInterruptedError(signal);

    expect(error).toMatchObject({
      exitCode,
      message: `Received ${signal}`,
      name: "HostedCampaignInterruptedError",
      signal,
    });
  });
});
