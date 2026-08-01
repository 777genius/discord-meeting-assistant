import { canonicalJsonSha256 } from "@discord-meeting/subscription-runtime-adapter";
import { describe, expect, it } from "vitest";

import { reconstructCanonicalRequest } from "../src/policy.js";
import { canonicalRequest, grpcRequest, isolatedCwd } from "./fixture.js";

const options = {
  isolatedCwd,
  maxPromptBytes: 2 * 1_024 * 1_024,
  maxTaskTimeoutMs: 600_000,
};

describe("subscription runtime request policy", () => {
  it("reconstructs the consumer-owned nested request without semantic drift", () => {
    const reconstructed = reconstructCanonicalRequest(grpcRequest(), options);

    expect(reconstructed).toEqual(canonicalRequest);
    expect(canonicalJsonSha256(reconstructed)).toBe(
      canonicalJsonSha256(canonicalRequest),
    );
  });

  it.each([
    ["unknown purpose", { purpose: "discord_meeting.other" }],
    ["wrong provider", { provider: "AGENT_RUNTIME_PROVIDER_CLAUDE" }],
    ["wrong workspace", { workspaceId: "meeting-other" }],
    ["non-isolated cwd", { cwd: "/tmp" }],
  ])("rejects %s before execution", (_label, override) => {
    expect(() =>
      reconstructCanonicalRequest({ ...grpcRequest(), ...override }, options),
    ).toThrow();
  });

  it("rejects conflicting controls and JSON schema", () => {
    const request = grpcRequest();
    const controls = JSON.parse(String(request.controlsJson)) as Record<
      string,
      unknown
    >;
    controls.model = "gpt-other";
    expect(() =>
      reconstructCanonicalRequest(
        { ...request, controlsJson: JSON.stringify(controls) },
        options,
      ),
    ).toThrow("policy");

    expect(() =>
      reconstructCanonicalRequest(
        { ...request, outputSchemaJson: '{"type":"string"}' },
        options,
      ),
    ).toThrow("output schema");
  });
});
