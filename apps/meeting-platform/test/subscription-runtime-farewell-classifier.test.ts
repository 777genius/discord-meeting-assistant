import {
  auditedSubscriptionRuntimePackageVersion,
  canonicalJsonSha256,
  subscriptionRuntimeCliEngine,
  subscriptionRuntimeConversationModel,
  subscriptionRuntimeConversationPurpose,
  subscriptionRuntimeConversationReasoningEffort,
  subscriptionRuntimeProvider,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";
import { describe, expect, it } from "vitest";

import { SubscriptionRuntimeFarewellClassifier } from "../src/adapters/outbound/subscription-runtime-farewell-classifier.js";

const launcherSha256 = "a".repeat(64);

class ClassifierTransport implements SubscriptionRuntimeTransportPort {
  public answer = "END_RU";
  public capturedRequest: SubscriptionRuntimeAgentTaskRequest | undefined;

  public async checkHealth() {
    return {
      launcherSha256,
      runtimeEngine: subscriptionRuntimeCliEngine,
      runtimeVersion: auditedSubscriptionRuntimePackageVersion,
      status: "serving" as const,
      warningCodes: [],
    };
  }

  public async execute(request: SubscriptionRuntimeAgentTaskRequest) {
    this.capturedRequest = request;
    const structuredOutput: JsonObject = { answer: this.answer };
    return {
      executionAttestation: {
        canonicalRequestSha256: canonicalJsonSha256(request),
        launcherSha256,
        model: subscriptionRuntimeConversationModel,
        provider: subscriptionRuntimeProvider,
        purpose: subscriptionRuntimeConversationPurpose,
        reasoningEffort: subscriptionRuntimeConversationReasoningEffort,
        requestId: request.runId,
        runtimeEngine: subscriptionRuntimeCliEngine,
        runtimePackageVersion: auditedSubscriptionRuntimePackageVersion,
        schemaVersion: 1,
        selectedOutputKind: "structured_output",
        selectedOutputSha256: canonicalJsonSha256(structuredOutput),
      },
      protocolVersion: 1,
      status: "completed" as const,
      structuredOutput,
    };
  }
}

describe("SubscriptionRuntimeFarewellClassifier", () => {
  it("maps the attested bounded classifier token to a locale", async () => {
    const transport = new ClassifierTransport();
    const classifier = new SubscriptionRuntimeFarewellClassifier(
      transport,
      launcherSha256,
    );

    await expect(classifier.classify(classificationInput())).resolves.toBe("ru");
    expect(transport.capturedRequest?.task.controls.disableTools).toBe(true);
    expect(transport.capturedRequest?.task.prompt).toContain("мне пора");
  });

  it("fails closed for any output outside the three admitted tokens", async () => {
    const transport = new ClassifierTransport();
    transport.answer = "The meeting is probably ending";
    const classifier = new SubscriptionRuntimeFarewellClassifier(
      transport,
      launcherSha256,
    );

    await expect(classifier.classify(classificationInput())).resolves.toBe("reject");
  });
});

function classificationInput() {
  return {
    meetingId: "meeting-1",
    participantIds: ["speaker-1", "speaker-2"],
    participantNames: { "speaker-1": "Иван", "speaker-2": "Анна" },
    revision: 7,
    turns: [
      {
        endMs: 2_000,
        speakerId: "speaker-1",
        startMs: 1_000,
        text: "мне пора, вы продолжайте",
        turnId: "turn-1",
      },
    ],
  } as const;
}
