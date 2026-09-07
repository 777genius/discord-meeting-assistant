import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { infinityDocumentEmbeddingInput, normalizeInfinityEmbeddingInput } from "../src/infinity-embedding-input.js";

describe("Infinity Python embedding normalization", () => {
  it("matches Python 3.12 Unicode 15 over every supported Unicode codepoint", () => {
    // Python oracle: sha256 of re.sub(r"\\s+", " ", chr(i).strip().lower())
    // + NUL, UTF-8 encoded in codepoint order, excluding the rejected points.
    const digest = createHash("sha256");
    let rejected = 0;
    for (let point = 0; point <= 0x10ffff; point += 1) {
      try {
        digest.update(`${normalizeInfinityEmbeddingInput(String.fromCodePoint(point))}\0`);
      } catch {
        rejected += 1;
      }
    }
    expect(rejected).toBe(2103);
    expect(digest.digest("hex")).toBe("71e0607641ee79964146b5b722898fdd3348e1b7fd346d837f53c7dabd19a406");
  });

  it("matches Python final-Sigma context across every supported codepoint", () => {
    const digest = createHash("sha256");
    let rejected = 0;
    for (let point = 0; point <= 0x10ffff; point += 1) {
      const character = String.fromCodePoint(point);
      for (const text of [`AΣ${character}`, `A${character}Σ`, `AΣ${character}A`, `A${character}ΣA`]) {
        try {
          digest.update(`${normalizeInfinityEmbeddingInput(text)}\0`);
        } catch {
          rejected += 1;
        }
      }
    }
    expect(rejected).toBe(8976);
    expect(digest.digest("hex")).toBe("75657f8c5fc7c2596ff037d324276de6e4c8b96b5a97048840a00b3a9ce021af");
    // Case_Ignorable scans may cross any number of marks, in either direction.
    expect(normalizeInfinityEmbeddingInput("ΟΣ ΟΣΑ A\u0301\u0301Σ Σ AΣ\u0301\u0301A"))
      .toBe("ος οσα a\u0301\u0301ς σ aσ\u0301\u0301a");
  }, 30_000);

  it("preserves BOM, strips Python control whitespace and expands dotted I", () => {
    expect(normalizeInfinityEmbeddingInput("\u001c\u0085 İ\tПРИВЕТ\n\u001f")).toBe("i\u0307 привет");
    expect(normalizeInfinityEmbeddingInput("\ufeffHELLO\ufeff")).toBe("\ufeffhello\ufeff");
    expect(normalizeInfinityEmbeddingInput("\u0085\u001c")).toBe("");
  });

  it("fails closed on incompatible Sigma context, newer lowercase mappings and lone surrogates", () => {
    for (const input of ["AΣ\u0295", "\u1c89", "\ud800", "\udfff", "\u{16ea0}"]) {
      expect(() => normalizeInfinityEmbeddingInput(input)).toThrow("Unsupported Unicode");
    }
    expect(normalizeInfinityEmbeddingInput("ος σ 😀")).toBe("ος σ 😀");
  });

  it("reproduces title insertion and casefold prefix deduplication", () => {
    const title = `mkevidence1.${"S".repeat(43)}`;
    expect(infinityDocumentEmbeddingInput(title, "  BODY\n TEXT  ")).toBe(`${title.toLowerCase()} body text`);
    expect(infinityDocumentEmbeddingInput(title, "")).toBe(title.toLowerCase());
    expect(infinityDocumentEmbeddingInput(title, `${title}tail`)).toBe(`${title.toLowerCase()}tail`);
    const foldedPrefix = `mkevidence1.${"ſ".repeat(43)} trailing`;
    expect(infinityDocumentEmbeddingInput(title, foldedPrefix)).toBe(foldedPrefix);
    for (const invalid of [title + "\n", title.slice(1), "" , `mkevidence1.${"!".repeat(43)}`]) {
      expect(() => infinityDocumentEmbeddingInput(invalid, "body")).toThrow("Invalid Infinity evidence title");
    }
  });
});
