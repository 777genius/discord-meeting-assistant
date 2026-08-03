import { canonicalJsonSha256 } from "@discord-meeting/subscription-runtime-adapter";
import { describe, expect, it } from "vitest";

import { reconstructCanonicalRequest } from "../src/policy.js";
import {
  canonicalRequest,
  grpcRequest,
  incrementalCanonicalRequest,
  isolatedCwd,
} from "./fixture.js";

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
    expect(reconstructed.task.controls).toMatchObject({
      maxOutputTokens: 4_096,
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
  });

  it("reconstructs only the exact incremental Luna low 2048-token profile", () => {
    const reconstructed = reconstructCanonicalRequest(
      grpcRequest(incrementalCanonicalRequest),
      options,
    );

    expect(reconstructed).toEqual(incrementalCanonicalRequest);
    expect(reconstructed.context.purpose).toBe("discord_meeting.summary.incremental");
    expect(reconstructed.context.metadata.policyVersion).toBe(
      "meeting-summary.incremental.subscription-runtime.v2",
    );
    expect(reconstructed.task.controls).toMatchObject({
      maxOutputTokens: 2_048,
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    });
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

  it("rejects purpose/metadata profile mismatches before execution", () => {
    const request = grpcRequest(incrementalCanonicalRequest);

    expect(() => reconstructCanonicalRequest(
      { ...request, purpose: "discord_meeting.summary.generate" },
      options,
    )).toThrow("profile");
  });

  it("fails closed for stale incremental policy and output-budget profiles", () => {
    const request = grpcRequest(incrementalCanonicalRequest);
    const controls = JSON.parse(String(request.controlsJson)) as Record<string, unknown>;
    controls.maxOutputTokens = 4_096;
    expect(() => reconstructCanonicalRequest(
      { ...request, controlsJson: JSON.stringify(controls) },
      options,
    )).toThrow("profile");

    const swappedModelControls = JSON.parse(String(request.controlsJson)) as Record<string, unknown>;
    swappedModelControls.model = "gpt-5.6-sol";
    expect(() => reconstructCanonicalRequest(
      { ...request, controlsJson: JSON.stringify(swappedModelControls) },
      options,
    )).toThrow("profile");

    const metadata = request.metadata as Record<string, unknown>;
    expect(() => reconstructCanonicalRequest(
      {
        ...request,
        metadata: {
          ...metadata,
          policyVersion: "meeting-summary.incremental.subscription-runtime.v1",
        },
      },
      options,
    )).toThrow("policy");
  });
});
