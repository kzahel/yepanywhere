// @vitest-environment node
import { expect, it } from "vitest";
import { bannedClassUses } from "./bannedClasses";

it("rejects retired census classes without a mapping or stylesheet dependency", () => {
  // These rows were removed with their swept-family census pages.
  expect(
    bannedClassUses(
      '<Button className="btn-primary toggle-switch settings-input model-switch-tab onboarding-footer" />',
    ).map((match) => match[0]),
  ).toEqual([
    "btn-primary",
    "toggle-switch",
    "settings-input",
    "model-switch-tab",
    "onboarding-footer",
  ]);
  expect(
    bannedClassUses(
      '// btn-primary\n<div data-testid="btn-primary" className="my-btn-primary-extra" />',
    ),
  ).toEqual([]);
  // Restoring CSS cannot re-enable a retired class.
  expect(bannedClassUses(".btn-primary { color: red; }")[0]?.[0]).toBe(
    "btn-primary",
  );
});
