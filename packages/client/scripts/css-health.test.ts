import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildInventory } from "../../../scripts/css-inventory.ts";
import {
  collectContainment,
  composeCssHealth,
} from "../../../scripts/css-health.ts";
import { analyze } from "../../../scripts/find-unused-css.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const fixtureDir = path.join(repoRoot, "scripts/fixtures/find-unused-css");
const baseline = path.join(
  repoRoot,
  "scripts/fixtures/css-health-baseline.json",
);

describe("CSS health summary", () => {
  it("composes containment, ownership, module, escape, and dead-code facts", () => {
    const containment = collectContainment(fixtureDir, baseline);
    const inventory = buildInventory({
      cssDir: fixtureDir,
      srcDir: fixtureDir,
      ownerDir: fixtureDir,
    });
    const { result } = analyze({ cssDir: fixtureDir, srcDir: fixtureDir });
    const health = composeCssHealth(containment, inventory, result);

    expect(health.containment).toMatchObject({
      authoredStylesheets: 8,
      authoredLines: 139,
      globalStylesheets: 1,
      globalLines: 53,
      moduleStylesheets: 7,
      moduleLines: 86,
      ratchet: {
        atLimit: [
          {
            file: "scripts/fixtures/find-unused-css/global.css",
            lines: 53,
            limit: 53,
          },
        ],
        aboveLimit: [],
        unreviewed: [],
        stale: [],
      },
    });
    expect(health.modules.files).toBe(7);
    expect(health.modules.contractIssues).toBeGreaterThan(0);
    expect(health.escapeHatches.globalInteropReferences).toBeGreaterThan(0);
    expect(health.escapeHatches.invalidReferences).toBeGreaterThan(0);
    expect(health.deadCode.unusedGlobalClassSelectors).toBeGreaterThan(0);
    expect(health.ownership.rules).toEqual(
      expect.objectContaining({ owned: expect.any(Number) }),
    );
  });
});
