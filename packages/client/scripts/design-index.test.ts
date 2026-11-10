// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  scanCustomProperties,
  undefinedCustomProperties,
} from "../../../scripts/lib/css-custom-properties.mjs";
import { loadDesignIndex, parseSpecimen } from "./design-index";

describe("design index", () => {
  it("keeps source order, storyName and the playground's ids", () => {
    const parsed = parseSpecimen(
      "x.specimen.tsx",
      `export default {
        title: "Controls/Icon Button",
        parameters: { layer: "control" },
      } satisfies SpecimenMeta;
      export function Primary() { return null; }
      export const DangerOutline = () => null;
      DangerOutline.storyName = "Danger, outlined";
      export const helperValue = 3;`,
    );
    expect(parsed.id).toBe("controls-icon-button");
    expect(parsed.states).toEqual([
      {
        id: "controls-icon-button--primary",
        name: "Primary",
        export: "Primary",
        href: "design.html#/controls-icon-button--primary?iso",
      },
      {
        id: "controls-icon-button--danger-outline",
        name: "Danger, outlined",
        export: "DangerOutline",
        href: "design.html#/controls-icon-button--danger-outline?iso",
      },
    ]);
  });

  it("rejects a specimen without a literal title and layer", () => {
    expect(() =>
      parseSpecimen("x.specimen.tsx", "export default { title: name };"),
    ).toThrow(/literal title and parameters.layer/);
  });

  it("indexes every checked-in specimen", async () => {
    const index = await loadDesignIndex();
    expect(index.specimens.map((specimen) => specimen.id)).toEqual(
      expect.arrayContaining(["tokens", "census-composer"]),
    );
    expect(
      index.specimens
        .filter((specimen) => specimen.layer === "census")
        .map((specimen) => specimen.id),
    ).toEqual([
      "census-button-base-exceptions",
      "census-composer",
      "census-control-overrides",
      "census-element-exceptions",
      "census-runtime-class-families",
      "census-token-literals",
    ]);
  });
});

describe("custom property scan", () => {
  it("separates definitions, reads and fallbacks", () => {
    const scan = scanCustomProperties([
      {
        path: "a.css",
        text: `:root { --defined: 1px; }
/* var(--in-comment) */
.a { color: var(--defined); margin: var(--missing); }
.b { color: var(--missing, red); }`,
      },
      {
        path: "b.tsx",
        text: `const style = { "--from-style": 1, ["--computed" as string]: 2 };
el.style.setProperty("--set-at-runtime", "1");
const SHIFT = "--held-in-constant";
el.style.setProperty(
  SHIFT,
  "1px",
);
const UNSET = "--constant-never-set";
el.style.getPropertyValue("--only-read");
const css = "width: var(--from-style) var(--set-at-runtime) var(--computed) var(--held-in-constant)";
el.style.getPropertyValue(UNSET);
const other = "var(--constant-never-set)";`,
      },
    ]);
    expect(undefinedCustomProperties(scan)).toEqual([
      {
        name: "--missing",
        uses: 2,
        withoutFallback: 1,
        sites: [
          { path: "a.css", line: 3, fallback: false },
          { path: "a.css", line: 4, fallback: true },
        ],
      },
      {
        name: "--constant-never-set",
        uses: 1,
        withoutFallback: 1,
        sites: [{ path: "b.tsx", line: 12, fallback: false }],
      },
    ]);
  });
});
