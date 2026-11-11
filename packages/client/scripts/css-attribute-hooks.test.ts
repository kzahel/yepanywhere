import { describe, expect, it } from "vitest";
import {
  emittedAttributes,
  attributeHookFindings,
  ratchetAttributeHooks,
} from "../../../scripts/lib/css-attribute-hooks.mjs";

function findings(source: string, css: string, families: object[] = []) {
  return attributeHookFindings(
    new Map([["Owner.module.css", css]]),
    emittedAttributes(new Map([["Owner.tsx", source]])),
    families,
  );
}

describe("CSS attribute emission contracts", () => {
  it("recognizes JSX/prop maps, dataset assignments and DOM/HTML producers, without admitting queries, reads or comments", () => {
    const rows = findings(
      `
      const ATTRIBUTE = 'data-imperative';
      const STATE = 'previousThinking';
      const node = <div data-jsx="visible" aria-label="Custom action" {...props}/>;
      const props = { 'data-spread': 'yes' };
      target.setAttribute(ATTRIBUTE, 'on');
      target.dataset[STATE] = 'stacked';
      target.dataset.dragState = 'dragging';
      const html = '<span data-generated="line"></span>';
      target.querySelector('[data-query]'); target.dataset.readOnly;
      // <div data-comment />
    `,
      `[data-jsx="visible"], [data-spread="yes"], [data-imperative="on"], [data-previous-thinking="stacked"], [data-drag-state="dragging"], [data-generated="line"], [aria-label="Custom action"], [data-query], [data-read-only], [data-comment] { color: red }`,
    );
    expect(rows.map((row: { name: string }) => row.name)).toEqual([
      "data-query",
      "data-read-only",
      "data-comment",
    ]);
  });

  it("checks exact/custom values, token lists and nested selectors, while allowing dynamic producer values", () => {
    const rows = findings(
      `const x = <div data-kind="ready pending" data-dynamic={runtime} aria-label="Expected"/>;`,
      `@media (width < 500px) { .root:is([data-kind~="ready"], [data-kind="missing"]):has([data-dynamic="any"]) [aria-label="Wrong"] { color: red } }`,
    );
    expect(
      rows.map((row: { name: string; value: string }) => [row.name, row.value]),
    ).toEqual([
      ["data-kind", "missing"],
      ["aria-label", "Wrong"],
    ]);
    expect(findings("", "[aria-expanded=true] { display: block }")).toEqual([]);
    // A label containing an ARIA keyword is still custom text, not an enum.
    expect(findings("", '[aria-label="off"] { display: block }')).toHaveLength(
      1,
    );
  });

  it("requires a declared family rather than inferring emission from a runtime prefix", () => {
    expect(
      findings(
        "const prefix='data-generated-';",
        "[data-generated-line] { color: red }",
      ),
    ).toHaveLength(1);
    expect(
      findings("", "[data-generated-line] { color: red }", [
        { attribute: "^data-generated-line$", value: "^.*$" },
      ]),
    ).toEqual([]);
  });

  it("records only falling counts and refuses partial writes when another finding grows", () => {
    const old = { missing: { count: 2, reason: "External runtime producer" } };
    expect(ratchetAttributeHooks([{ key: "missing" }], old)).toMatchObject({
      errors: [],
      next: { missing: { count: 1 } },
      stale: ["missing"],
    });
    expect(ratchetAttributeHooks([{ key: "new" }], old).next).toEqual(old);
    expect(ratchetAttributeHooks([], old).next).toEqual({});
    expect(
      ratchetAttributeHooks([], { missing: { count: 1, reason: " " } }).errors,
    ).toHaveLength(1);
  });
});
