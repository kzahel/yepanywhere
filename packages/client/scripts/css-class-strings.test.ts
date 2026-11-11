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
