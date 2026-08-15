import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { classifyHistoricalGroundingMode } from
  "@discord-meeting/meeting-core/meeting-knowledge";

import {
  QUALIFICATION_CORPUS_TURN_COUNT,
  combinedQualificationMeeting,
  forbiddenPromptMaterial,
  qualificationQuestions,
} from "./infinity-context-qualification-corpus.js";

describe("Infinity Context combined qualification corpus contract", () => {
  it("pins one deterministic >400-turn RU/EN corpus with every required adversarial shape", () => {
    const meeting = combinedQualificationMeeting();
    const texts = meeting.humanTurns.map(({ text }) => text);
    const corpusBytes = Buffer.from(JSON.stringify(meeting.humanTurns), "utf8");

    expect(QUALIFICATION_CORPUS_TURN_COUNT).toBe(421);
    expect(meeting.humanTurns).toHaveLength(QUALIFICATION_CORPUS_TURN_COUNT);
    expect(texts.some((text) => /[A-Za-z]/u.test(text))).toBe(true);
    expect(texts.some((text) => /[А-Яа-яЁё]/u.test(text))).toBe(true);
    expect(texts[0]).toContain("early EN");
    expect(texts[210]).toContain("middle RU/EN");
    expect(texts[420]).toContain("final EN/RU");
    expect(texts[84]).toBe(texts[85]);
    expect(texts[105]).toContain("12 regions");
    expect(texts[106]).toMatch(/Actually.+not 12.+revised total is 9/iu);
    expect(texts[315]).toMatch(/ignore prior instructions/iu);
    expect(texts[333]).toBe(forbiddenPromptMaterial.unselectedTranscriptTurn);
    expect(createHash("sha256").update(corpusBytes).digest("hex"))
      .toBe("ab628151b11d8a4e2d0807db4c0fac6e2c15969253ea7495eb095a715766b3bf");
  });

  it("routes focused and all/count/absence/universal questions deterministically", () => {
    for (const question of qualificationQuestions.focused) {
      expect(classifyHistoricalGroundingMode(question)).toBe("focused_retrieval");
    }
    for (const question of [
      qualificationQuestions.all,
      qualificationQuestions.count,
      qualificationQuestions.absence,
      qualificationQuestions.universal,
    ]) {
      expect(classifyHistoricalGroundingMode(question)).toBe("exhaustive_coverage");
    }
  });

  it("keeps production transport on the official SDK and contains no custom HTTP client", () => {
    const sourceRoot = new URL("../src/", import.meta.url);
    const productionPaths = readdirSync(sourceRoot, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => new URL(entry.name, new URL(`${entry.parentPath}/`, "file:")))
      .toSorted((left, right) => left.href.localeCompare(right.href));
    // Adding a production source expands the reviewed transport boundary and
    // must fail this contract until the exhaustive inventory is re-attested.
    expect(productionPaths).toHaveLength(8);
    const sourceFiles = productionPaths.map((path) => readFileSync(path, "utf8"));
    const source = sourceFiles.join("\n");

    expect(source).toContain('from "@infinity-context/sdk"');
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/from\s+["'](?:node:)?https?["']/u);
    expect(source).not.toMatch(/from\s+["'](?:axios|got|undici)["']/u);
  });

  it("keeps the disposable live qualification on the adapter's real SDK HTTP transport", () => {
    const helper = readFileSync(
      new URL("./real-service-qualification-helper.ts", import.meta.url),
      "utf8",
    );
    const entrypoint = readFileSync(
      new URL("./infinity-context-real-service.e2e.test.ts", import.meta.url),
      "utf8",
    );

    expect(helper).toContain("new InfinityContextHistoricalMemoryAdapter({");
    expect(helper).not.toContain('from "@infinity-context/sdk"');
    expect(helper).not.toMatch(/\btransport\s*:/u);
    expect(helper).not.toMatch(/\bfetch\s*\(/u);
    expect(`${helper}\n${entrypoint}`).not.toMatch(/writeFile|qualificationManifest/iu);
    expect(entrypoint).toContain("deterministic-mock-non-production-v1");
  });
});
