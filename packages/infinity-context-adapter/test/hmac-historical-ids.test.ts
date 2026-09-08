import { describe, expect, it } from "vitest";
import { HmacHistoricalOpaqueIds, assertConstructedHmacHistoricalOpaqueIds } from "../src/hmac-historical-ids.js";

const key = "synthetic-topology-key".padEnd(32, "!");

describe("trusted actor-profile-bound historical HMAC", () => {
  it("preserves the prior wrapper's exact IDs, including UTF-8 framing", () => {
    const plain = new HmacHistoricalOpaqueIds(key);
    const bound = new HmacHistoricalOpaqueIds(key, "actor-profile-1");
    for (const namespace of ["historical-index-generation", "historical-document", "historical-room"]) {
      for (const parts of [[], ["scope", "room"], ["é|:", "", "会议"]]) {
        expect(bound.keyedId(namespace, parts)).toBe(plain.keyedId(namespace,
          namespace === "historical-index-generation" ? [...parts, "actor-profile-1"] : parts));
      }
    }
    expect(() => { assertConstructedHmacHistoricalOpaqueIds(bound); }).not.toThrow();
    expect(() => { assertConstructedHmacHistoricalOpaqueIds(plain); }).not.toThrow();
  });

  it("rotates only generation identity when the actor profile changes", () => {
    const first = new HmacHistoricalOpaqueIds(key, "profile-1");
    const rotated = new HmacHistoricalOpaqueIds(key, "profile-2");
    expect(first.keyedId("historical-index-generation", ["meeting"]))
      .not.toBe(rotated.keyedId("historical-index-generation", ["meeting"]));
    expect(first.keyedId("historical-document", ["meeting"]))
      .toBe(rotated.keyedId("historical-document", ["meeting"]));
  });

  it("rejects forwarding wrappers and forged prototypes", () => {
    const ids = new HmacHistoricalOpaqueIds(key, "profile-1");
    const wrapper = { keyedId: (namespace: string, parts: readonly string[]) => ids.keyedId(namespace, parts) };
    for (const value of [wrapper, Object.create(HmacHistoricalOpaqueIds.prototype)]) {
      expect(() => { assertConstructedHmacHistoricalOpaqueIds(value); }).toThrow(/not constructed/u);
    }
  });
});
