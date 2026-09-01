import { describe, expect, it } from "vitest";

import { alignFocusedHydrationSurvivors } from
  "../../../src/features/meeting-knowledge/application/select-focused-evidence.js";
import {
  binding,
  references,
  selectedTurns,
} from "./local-final-reply-application-fixtures.test.js";

describe("focused hydration survivor alignment", () => {
  it("keeps an exact in-order subset after canonical hydration", () => {
    const result = alignFocusedHydrationSurvivors(
      binding(),
      references,
      [selectedTurns[1]!],
    );

    expect(result?.references).toEqual([references[1]]);
    expect(result?.turns).toEqual([selectedTurns[1]]);
  });

  it("fails closed when hydrated turns reorder the requested references", () => {
    expect(alignFocusedHydrationSurvivors(
      binding(),
      references,
      selectedTurns.toReversed(),
    )).toBeNull();
  });
});
