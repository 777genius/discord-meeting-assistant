import { describe, expect, it } from "vitest";

import { DiscordConfusableIdentitySkeletons } from "../src/index.js";

const skeletons = new DiscordConfusableIdentitySkeletons();

describe("Discord confusable identity skeletons", () => {
  it.each([
    "Alice",
    "Аlice",
    "Αlice",
    "Ａｌｉｃｅ",
    "𝐀𝐥𝐢𝐜𝐞",
    "аӏісе",
    "АLІСЕ",
    "A\u0338lice",
  ])("maps the all-script Alice lookalike %s to one certain skeleton", (value) => {
    expect(skeletons.skeleton(value)).toMatchObject({
      certainty: "certain",
      skeleton: "alice",
    });
  });

  it.each([
    "Аli\u200Bce",
    "Αli\u202Ece",
    "Аli\u2063ce",
    "Аli\u034Fce",
  ])("marks invisible or bidi identity text uncertain: %s", (value) => {
    expect(skeletons.skeleton(value)).toMatchObject({
      certainty: "uncertain",
      skeleton: "alice",
    });
  });

  it("does not collapse unrelated Russian, English, symbols, or CJK into Alice", () => {
    expect(skeletons.skeleton("обычный").certainty).toBe("uncertain");
    expect(skeletons.skeleton("ordinary")).toMatchObject({
      certainty: "certain",
      skeleton: "ordinary",
    });
    expect(skeletons.skeleton("🔥").certainty).toBe("uncertain");
    expect(skeletons.skeleton("普通").certainty).toBe("uncertain");
    expect(skeletons.skeleton("обычный").skeleton).not.toBe("ordinary");
  });
});
