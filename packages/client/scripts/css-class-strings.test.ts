import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classStringFindings,
  ratchetClassStrings,
} from "../../../scripts/lib/css-class-strings.mjs";

function scan(text: string, extra: Record<string, string> = {}) {
  const root = path.resolve("/virtual/client");
  return classStringFindings(
    new Map(
      Object.entries({ "Owner.tsx": text, ...extra }).map(([file, source]) => [
        path.join(root, file),
        source,
      ]),
    ),
  );
}

describe("class string ownership", () => {
  it("keeps class-helper object semantics through bindings, imports, arrays and spreads", () => {
    const findings = scan(
      `
      import { flags } from './flags';
      const local = { 'bound-key': active };
      const a = <div className={clsx(flags, local)} />;
      const b = <div className={cx({ ...local }, [{ 'nested-key': active }])} />;
      const map = { state: 'map-value' }; const c = <div className={map[state]} />;
      const dictionaries = { a: { 'selected-key': active }, b: { 'other-key': active } };
      const selected = <div className={clsx(dictionaries[state])} />;
      const shortA = { 'shorthand-key': active }; const shortB = { 'other-short-key': active };
      const shorthand = { shortA, shortB }; const shortSelected = <div className={clsx(shorthand[state])} />;
    `,
      { "flags.ts": "export const flags = { 'imported-key': active };" },
    );
    expect(new Set(findings.map((row: { name: string }) => row.name))).toEqual(
      new Set([
        "bound-key",
        "imported-key",
        "nested-key",
        "map-value",
        "selected-key",
        "other-key",
        "shorthand-key",
        "other-short-key",
      ]),
    );
  });

  it("recognizes static computed DOM writes and bound attribute names", () => {
    const findings = scan(
      `const attr = 'class'; el['className'] = 'computed'; el.setAttribute(attr, 'bound'); el['setAttribute'](attr, 'computed-set'); el['classList']['add']('computed-add'); const props = { ['className']: 'computed-prop' };`,
    );
    expect(findings.map((row: { name: string }) => row.name)).toEqual([
      "computed",
      "bound",
      "computed-set",
      "computed-add",
      "computed-prop",
    ]);
  });

  it("restricts generated emissions to their producer and validates complete HTML template tokens", () => {
    const file = path.resolve("/virtual/client/Owner.tsx");
    const findings = classStringFindings(
      new Map([
        [
          file,
          `
      const valid = '<div class="heading-1"></div>';
      const dynamic = \`<div class="heading-\${level}"></div>\`;
      const suffix = \`<div class="heading-\${level}-orphan"></div>\`;
      const multi = \`<div class="heading-\${level}-\${state}"></div>\`;
      const authored = <div className="heading-1" />;
      const directSpread = <div {...{ className: "heading-1" }} />;
      const props = { className: "heading-1" }; const boundSpread = <div {...props} />;
      const nested = { native: { className: "heading-1" } }; const propertySpread = <div {...nested.native} />;
      el.querySelector('.heading-1'); el.classList.contains('heading-1');
    `,
        ],
        [
          path.resolve("/virtual/client/Other.tsx"),
          `const foreign = '<div class="heading-1"></div>'; const jsx = <div className="heading-1"/>;`,
        ],
      ]),
      [{ pattern: "^heading-[1-6]$", source: "client/Owner.tsx" }],
      ["heading-1", "heading-2"],
    );
    expect(findings.map((row: { name: string }) => row.name)).toEqual([
      "heading-__EXPR_0__-orphan",
      "heading-__EXPR_0__-__EXPR_1__",
      "heading-1",
      "heading-1",
      "heading-1",
      "heading-1",
      "heading-1",
      "heading-1",
    ]);
  });

  it("follows lexical bindings, imported helpers, finite maps and class helper keys without treating conditions or module keys as classes", () => {
    const findings = scan(
      `
      import styles from './Owner.module.css';
      import { join } from './classes';
      const map = { active: 'mapped' };
      const klass = 'unused-shadow';
      function View() {
        const klass = 'local';
        return <div className={join(klass, styles['owned'], flag === 'condition' ? map.active : '')}/>;
      }
      const other = <div className={cx({ 'object-key': true, [klass]: true })}/>;
    `,
      {
        "classes.ts":
          "export const join = (...values: string[]) => values.filter(Boolean).join(' ');",
      },
    );
    expect(new Set(findings.map((row: { name: string }) => row.name))).toEqual(
      new Set(["mapped", "local", "object-key", "unused-shadow"]),
    );
  });

  it("finds DOM operations, HTML concatenation and parameters passed to markup builders", () => {
    const findings = scan(`
      const selector = 'button.old-hook:not(.nested)';
      el.closest(selector); el.matches('.match');
      el.querySelector(\` .\${'interpolated'}\`);
      el.closest(\`\${'.whole-selector'}\`);
      el.matches(\`.literal-\${state}\`);
      el.closest(\`.\${styles.root}\`);
      el.classList.add('mounted'); el.classList.toggle('toggled', flag);
      el.setAttribute('class', 'set'); el.className = 'assigned';
      function html(klass: string) { return '<div class="' + klass + '"></div>'; }
      html('argument');
      const rendered = '<span class="inline"></span>';
      const ignored = 'ordinary-string';
    `);
    expect(new Set(findings.map((row: { name: string }) => row.name))).toEqual(
      new Set([
        "old-hook",
        "nested",
        "match",
        "interpolated",
        "whole-selector",
        "literal-dynamic",
        "mounted",
        "toggled",
        "set",
        "assigned",
        "argument",
        "inline",
      ]),
    );
  });

  it("permits module expressions and declared emitter templates, never inferred runtime prefixes", () => {
    const file = path.resolve("/virtual/client/Owner.tsx");
    const findings = classStringFindings(
      new Map([
        [
          file,
          `
      const moduleOnly = <div className={\`\${styles.root}\${active ? ' ' + styles.active : ''}\`}/>;
      const generated = { className: \`heading-\${level}\` };
      const stale = <div className={\`orphan-\${state}\`}/>;
      const prefix = <div className="heading-"/>;
    `,
        ],
      ]),
      [
        {
          pattern: "^heading-[1-6]$",
          source: "client/Owner.tsx",
          generated: true,
        },
      ],
      ["heading-1", "heading-2"],
    );
    expect(findings.map((row: { name: string }) => row.name)).toEqual([
      "orphan-__EXPR_0__",
      "heading-",
    ]);
  });

  it("ratchets counts only after all findings and reasons pass validation", () => {
    const row = { file: "Owner.tsx", kind: "selector", name: "external" };
    const list = {
      "Owner.tsx:selector:external": { count: 2, reason: "External HTML" },
    };
    expect(ratchetClassStrings([row], list)).toMatchObject({
      errors: [],
      stale: ["Owner.tsx:selector:external"],
      next: { "Owner.tsx:selector:external": { count: 1 } },
    });
    expect(
      ratchetClassStrings([row, { ...row, name: "new" }], list).next,
    ).toEqual(list);
    expect(
      ratchetClassStrings([row], {
        "Owner.tsx:selector:external": { count: 2, reason: " " },
      }).errors,
    ).toHaveLength(1);
    expect(ratchetClassStrings([], list).next).toEqual({});
  });
});
