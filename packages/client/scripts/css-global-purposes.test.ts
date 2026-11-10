import { describe, expect, it } from "vitest";
import {
  globalPurposeFindings,
  ratchetPurposeExceptions,
} from "../../../scripts/lib/css-global-purposes.mjs";

const families = [{ pattern: "^ansi-red$", generated: true }];

describe("global stylesheet purposes", () => {
  it("checks nested theme declarations but permits font/property descriptors", () => {
    expect(
      globalPurposeFindings(
        `
      @font-face { font-family: Test; src: url(test.woff2); }
      @property --size { syntax: '<length>'; inherits: true; initial-value: 0px; }
      @media (prefers-color-scheme: light) {
        [data-theme="auto"] { --color: red; color: red; }
      }
      .component { --color: red; }
    `,
        "tokens",
      ).map((finding) => finding.key),
    ).toEqual(["tokens:declaration:color", "tokens:selector:class"]);
  });

  it("decodes classes in nested selectors and does not confuse runtime with generated families", () => {
    const css = `@media (width < 500px) {
      .shell .ansi-red, .shell .ansi\\2d red { color: red; }
      .shell code { color: red; }
      .runtime { color: red; }
    }`;
    const findings = globalPurposeFindings(css, "generated", [
      ...families,
      { pattern: "^runtime$" },
    ]);
    expect(findings.map((finding) => finding.key)).toEqual([
      "generated:context:shell",
      "generated:context:shell",
      "generated:context:shell",
      "generated:authored-subject",
      "generated:context:runtime",
    ]);
    expect(
      globalPurposeFindings("body { margin: 0 }", "generated", families).map(
        (finding) => finding.key,
      ),
    ).toEqual(["generated:authored-subject"]);
    expect(
      globalPurposeFindings(
        "body.source-pane-resizing, .source-pane-resizing * { user-select: none }",
        "base",
      ).map((finding) => finding.key),
    ).toEqual([
      "base:class:source-pane-resizing",
      "base:class:source-pane-resizing",
    ]);
  });

  it("requires generated ancestry for vocabulary also authored by React", () => {
    const shared = [
      {
        pattern: "^(line|prefix)$",
        generated: true,
        reactAuthored: ["prefix"],
      },
    ];
    expect(
      globalPurposeFindings(
        ".line > .prefix { color: red }",
        "generated",
        shared,
      ),
    ).toEqual([]);
    expect(
      globalPurposeFindings(".prefix { color: red }", "generated", shared).map(
        (finding) => finding.key,
      ),
    ).toEqual(["generated:authored-subject"]);
    for (const selector of [".prefix:not(.line)", ".prefix:has(.line)"]) {
      expect(
        globalPurposeFindings(
          `${selector} { color: red }`,
          "generated",
          shared,
        ).map((finding) => finding.key),
      ).toEqual(["generated:authored-subject"]);
    }
    expect(
      globalPurposeFindings(
        ".line:has(.prefix) { color: red }",
        "generated",
        shared,
      ),
    ).toEqual([]);
  });

  it("ratchets only after validating growth and reasons; stale counts remain visible", () => {
    const recorded = {
      "base:class:state": { count: 2, reason: "Document drag state" },
      "base:class:gone": { count: 1, reason: "Retired state" },
    };
    const findings = [{ key: "base:class:state" }];
    const state = ratchetPurposeExceptions(findings, recorded);
    expect(state.errors).toEqual([]);
    expect(state.lowered).toEqual({
      "base:class:state": { count: 1, reason: "Document drag state" },
    });
    expect(state.stale).toEqual(["base:class:state", "base:class:gone"]);
    expect(recorded["base:class:state"].count).toBe(2);
    expect(
      ratchetPurposeExceptions(
        [...findings, { key: "generated:authored-subject" }],
        recorded,
      ).errors,
    ).toHaveLength(1);
    expect(
      ratchetPurposeExceptions(findings, {
        "base:class:state": { count: 1, reason: " " },
      }).errors,
    ).toHaveLength(1);
  });
});
