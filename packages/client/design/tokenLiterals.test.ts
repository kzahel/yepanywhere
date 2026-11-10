// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  analyzeTokenLiterals,
  checkTokenAllowlist,
  tokenValueAllowed,
} from "./tokenLiterals";

describe("type/radius token ownership", () => {
  it("checks nested math and var fallbacks without accepting hidden absolute lengths or arbitrary variables", () => {
    for (const value of [
      "clamp(var(--font-size-xs), calc(var(--font-size-base) * 1.2), var(--font-size-xl))",
      "calc(0.9em + 2%)",
      "var(--font-size-xs, var(--font-size-sm))",
      "inherit",
      "0",
    ])
      expect(tokenValueAllowed("font-size", value), value).toBe(true);
    for (const value of [
      "calc(var(--font-size-xs) + 1px)",
      "var(--font-size-sm, 12px)",
      "var(--font-size-sm, calc(1rem * 2))",
      "var(--unreviewed-size)",
      "clamp(10px, 1em, 14px)",
      "small",
      "1rem",
      "1ex",
    ])
      expect(tokenValueAllowed("font-size", value), value).toBe(false);
    expect(
      tokenValueAllowed(
        "border-radius",
        "var(--radius-sm) 0 / calc(var(--radius-lg) * .5) 0",
      ),
    ).toBe(true);
    expect(tokenValueAllowed("border-radius", "1em")).toBe(false);
    expect(tokenValueAllowed("border-radius", "var(--font-size-sm)")).toBe(
      false,
    );
  });

  it("parses shorthand sizes separately from weights, line heights and quoted families; includes physical/logical corners", () => {
    const rows = analyzeTokenLiterals(
      "Panel.module.css",
      `
      /* font-size: 99px; */
      .panel { font: italic 450.5 75% var(--font-size-lg) / 24px "Font 12px"; }
      .other { font: 600 18px/1 system-ui; border-top-left-radius: 2px !important; }
      @media (width < 400px) { .corner { border-start-end-radius: 0.25rem; font: 75% 16px serif; } }
      .relative { font: .9em/16px monospace; font-size: 90%; }
    `,
    );
    expect(rows.map(({ property, value }) => [property, value])).toEqual([
      ["font", "600 18px/1 system-ui"],
      ["border-top-left-radius", "2px"],
      ["border-start-end-radius", "0.25rem"],
      ["font", "75% 16px serif"],
    ]);
  });

  it("requires explicit geometry for percentage radii that the full token cannot express", () => {
    expect(
      analyzeTokenLiterals(
        "Circle.module.css",
        ".dot { width: 8px; height: 8px; border-radius: 50%; }",
      ),
    ).toHaveLength(1);
    expect(
      analyzeTokenLiterals(
        "LargeCircle.module.css",
        ".circle { /* radius-percent: fluid circle grows beyond 1998px diameter */ border-radius: 50%; }",
      ),
    ).toHaveLength(0);
  });

  it("finds TSX numeric, string, computed-key, conditional and named style objects; ignores prose and dynamic values", () => {
    const rows = analyzeTokenLiterals(
      "Panel.tsx",
      `
      const prose = "fontSize: 24";
      const styles = { fontSize: 12, borderRadius: flag ? '4px' : 'var(--radius-sm)' };
      const element = <div style={{ ...styles, ['fontSize']: ('1rem' as const), borderTopLeftRadius: 2, font: '600 12px/20px monospace' }} />;
      const dynamic = <div style={{ fontSize: size, borderRadius: 0 }} />;
    `,
    );
    expect(rows.map(({ property, value }) => [property, value])).toEqual([
      ["fontSize", "12"],
      ["borderRadius", "4px"],
      ["fontSize", "1rem"],
      ["borderTopLeftRadius", "2"],
      ["font", "600 12px/20px monospace"],
    ]);
  });

  it("refuses new/increased and invalid exceptions even while recording; ratchets stale counts and removes cleared files", () => {
    const row = {
      file: "Panel.module.css",
      line: 1,
      property: "font-size",
      value: "20px",
    };
    const allowlist = {
      "Panel.module.css": { count: 2, reason: "Large drop-target glyph" },
      "Gone.tsx": { count: 1, reason: "Preboot fallback" },
    };
    expect(checkTokenAllowlist([row], allowlist).problems).toHaveLength(2);
    expect(checkTokenAllowlist([row], allowlist, true)).toEqual({
      problems: [],
      next: {
        "Panel.module.css": { count: 1, reason: "Large drop-target glyph" },
      },
    });
    expect(checkTokenAllowlist([row], {}, true).problems).toHaveLength(1);
    expect(
      checkTokenAllowlist(
        [row, row],
        { "Panel.module.css": { count: 1, reason: "Glyph" } },
        true,
      ).problems,
    ).toHaveLength(1);
    expect(
      checkTokenAllowlist(
        [row],
        { "Panel.module.css": { count: 1, reason: " " } },
        true,
      ).problems,
    ).toHaveLength(1);
  });
});
