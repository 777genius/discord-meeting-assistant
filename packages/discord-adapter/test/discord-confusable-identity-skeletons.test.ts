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
  ])("maps safe Alice lookalikes to one deny skeleton: %s", (value) => {
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
    "Ali\u0000ce",
    "Ali\u2060ce",
    "Ali\uFE0Fce",
    "Ali\uFFF0ce",
    "Ali\uFFF8ce",
    "Ali\u{E0061}ce",
    "Ali\u{E0100}ce",
  ])("marks invisible or bidi identity text uncertain: %s", (value) => {
    expect(skeletons.skeleton(value)).toMatchObject({
      certainty: "uncertain",
      skeleton: "alice",
    });
  });

  it.each([
    "Ali\u0009ce",
    "Ali\u000Ace",
    "Ali\u007Fce",
    "Ali\u0085ce",
    "Ali\u009Fce",
  ])("marks every C0/C1 control-bearing identity uncertain: %s", (value) => {
    expect(skeletons.skeleton(value)).toMatchObject({
      certainty: "uncertain",
      skeleton: "alice",
    });
  });

  it("keeps safe exact Russian, English, symbol, and CJK tokens certain", () => {
    expect(skeletons.skeleton("обычный").certainty).toBe("certain");
    expect(skeletons.skeleton("ordinary")).toMatchObject({
      certainty: "certain",
      skeleton: "ordinary",
    });
    expect(skeletons.skeleton("🔥").certainty).toBe("certain");
    expect(skeletons.skeleton("普通").certainty).toBe("certain");
    expect(skeletons.skeleton("обычный").skeleton).not.toBe("ordinary");
  });

  it.each([
    ["Boba", "Вова", "boba"],
    ["Hopa", "Нора", "hopa"],
    ["Pay", "Рау", "pay"],
  ])("exposes %s / %s only as a deny collision", (latin, cyrillic, denySkeleton) => {
    expect(skeletons.skeleton(latin)).toMatchObject({
      canonical: latin.toLocaleLowerCase("und"),
      certainty: "certain",
      skeleton: denySkeleton,
    });
    expect(skeletons.skeleton(cyrillic)).toMatchObject({
      canonical: cyrillic.toLocaleLowerCase("und"),
      certainty: "certain",
      skeleton: denySkeleton,
    });
  });
});
