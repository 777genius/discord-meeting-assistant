import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { HOSTED_VOICETEXT_CANARY_BINDING_V1 } from "../src/hosted-voicetext-canary-binding.js";
import {
  digestVoicetextCanaryExpectationV1,
  digestVoicetextCanaryRequiredTermsV1,
} from "../src/hosted-voicetext-semantic-canary-producer.js";

const expectedRequiredTermsSha256 = "03cd2882831443303db128db26428cf05ddcc15efd132da7b4479c4252e43818";

describe("hosted Voicetext semantic canary binding", () => {
  it("pins the committed bilingual audio and its exact source transcript", async () => {
    const binding = HOSTED_VOICETEXT_CANARY_BINDING_V1;
    const fixtureRoot = resolve("test/fixtures");
    const [audio, source] = await Promise.all([
      readFile(resolve(fixtureRoot, "speaker-a.ru-en.ogg")),
      readFile(resolve(fixtureRoot, "speaker-a.ru-en.txt")),
    ]);

    expect(sha256(audio)).toBe(binding.fixture.audioSha256);
    expect(sha256(source)).toBe(binding.fixture.sourceSha256);
    expect(source.toString("utf8").trim()).toBe(binding.fixture.sourceText);
    expect(binding.transcriptExpectation.segments).toEqual([{
      endMs: binding.fixture.durationMs,
      startMs: 0,
      text: binding.fixture.sourceText,
    }]);
    expect(digestVoicetextCanaryExpectationV1(binding.transcriptExpectation.segments))
      .toBe(binding.transcriptExpectation.sha256);
  });

  it("pins canonical provider endpoints, semantic thresholds, and terminology", () => {
    const binding = HOSTED_VOICETEXT_CANARY_BINDING_V1;

    expect(binding.endpoint).toEqual({
      batch: { origin: "https://api.voicetext.site", path: "/api/v1/transcribe/batch" },
      live: { origin: "wss://api.voicetext.site", path: "/api/v1/transcribe/stream" },
    });
    expect(binding.fixtureExpectation).toEqual({
      maximumCharacterErrorRate: 0.2,
      maximumTimelineDeltaMs: 60_000,
      maximumWordErrorRate: 0.35,
    });
    expect(digestVoicetextCanaryRequiredTermsV1(binding.requiredTerms))
      .toBe(expectedRequiredTermsSha256);
    expect(binding.requiredTerms.some((term) => /[А-Яа-яЁё]/u.test(term))).toBe(true);
    expect(binding.requiredTerms.some((term) => /[A-Za-z]/u.test(term))).toBe(true);
  });

  it("is recursively immutable at every operator-visible collection boundary", () => {
    const binding = HOSTED_VOICETEXT_CANARY_BINDING_V1;

    expect([
      binding,
      binding.endpoint,
      binding.endpoint.batch,
      binding.endpoint.live,
      binding.fixture,
      binding.fixtureExpectation,
      binding.requiredTerms,
      binding.transcriptExpectation,
      binding.transcriptExpectation.segments,
      ...binding.transcriptExpectation.segments,
    ].every(Object.isFrozen)).toBe(true);
  });
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
