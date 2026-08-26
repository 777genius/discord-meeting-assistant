import { describe, expect, it } from "vitest";

import { rejectTokenEnvironment, sanitizedCliError } from "../src/cli-secret-safety.js";

describe("private E2E CLI secret safety", () => {
  it.each(["DISCORD_TOKEN", "DISCORD_BOT_TOKEN", "DISCORD_E2E_HISTORICAL_REPLY_TOKEN"])(
    "rejects token environment input through %s",
    (name) => {
      expect(() => { rejectTokenEnvironment({ [name]: "not-read-by-the-cli" }); })
        .toThrow("TOKEN_ENV_FORBIDDEN");
    },
  );

  it("redacts inherited secret values and token-shaped text from bounded one-line errors", () => {
    const secret = "abcdefghijklmnopqrstuvwxyz.abcdef.abcdefghijklmnopqrstuvwxyz";
    const message = sanitizedCliError(new Error(`failed\nBearer ${secret} (${secret})`), {
      PRIVATE_TEST_PASSWORD: secret,
    });
    expect(message).not.toContain(secret);
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThanOrEqual(512);
  });
});
