import { describe, expect, it } from "vitest";
import { reachesModalFrame } from "./modalFrameSelectors";

describe("Modal frame boundaries", () => {
  it("keeps attribute hooks subject to the existing reach-in gate", () => {
    for (const selector of [
      "[data-modal-frame]:has(.content)",
      ".panel > [data-modal-content]",
      ".imageHeader > [data-modal-close]:first-of-type",
      '[data-modal-overlay="true"]:has(.viewer)',
    ]) {
      expect(reachesModalFrame(selector, true), selector).toBe(true);
      expect(reachesModalFrame(selector, false), selector).toBe(true);
    }
  });

  it("distinguishes module-local names and unrelated attribute prefixes", () => {
    expect(reachesModalFrame(".modal", true)).toBe(false);
    expect(reachesModalFrame("[data-modal-frame-extra]", true)).toBe(false);
    expect(reachesModalFrame("[data-modal-theme]", true)).toBe(false);
    expect(
      reachesModalFrame(":global(.modal-content):has(.viewer)", true),
    ).toBe(true);
    expect(reachesModalFrame(".modal:has(.viewer)", false)).toBe(true);
    expect(reachesModalFrame(".modal", false)).toBe(false);
  });
});
