// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buttonBaseStyleReason,
  checkButtonBaseAllowlist,
} from "./buttonBaseStyles";
import {
  analyzeControlOverrides,
  type OwnershipSource,
} from "./controlOverrides";

function scan(text: string, css: string, extra: OwnershipSource[] = []) {
  return analyzeControlOverrides(
    "/base-fixture",
    [
      {
        file: "Page.tsx",
        text: `import {ButtonBase as Base} from './components/ui/Button'; import s from './Page.module.css'; ${text}`,
      },
      { file: "Page.module.css", text: css },
      ...extra,
    ],
    "bases",
  ).overrides;
}

describe("ButtonBase painted surfaces", () => {
  it("combines class/state/media and real ancestor rules, without styling descendants or siblings", () => {
    const rows = scan(
      `const a=<div className={s.owner}><Base className={s.target}><span className={s.child}/></Base></div>; const b=<Base className={s.layout}/>;`,
      `
      .target {border: 1px solid grey} @media (pointer: coarse) {.owner > button:hover {background: red}}
      .target .child {color:var(--link-color)} .layout > span {border:1px solid red;background:red}
      .layout + button {border:1px solid red;background:red}
    `,
    );
    expect(rows.map(buttonBaseStyleReason)).toEqual([
      "background and border",
      undefined,
    ]);
  });

  it("resolves forwarded finite classes, aliases, spreads and separate custom-property definitions", () => {
    const rows = scan(
      `import {Wrapper} from './Wrapper'; const a=<Wrapper className={s.box}/>; const b=<Base {...{className:'link'}}/>;`,
      `
      .box {--fill:transparent;border:1px solid grey} .box {background:var(--fill)}
    `,
      [
        {
          file: "Wrapper.tsx",
          text: "import {ButtonBase} from './components/ui/Button'; export function Wrapper({className}) {return <ButtonBase className={className}/>;}",
        },
        {
          file: "styles/global.css",
          text: ".link {--ink:var(--accent-color);color:var(--ink);background:none;border:0}",
        },
      ],
    );
    expect(rows.map(buttonBaseStyleReason)).toEqual([
      "link/accent text without chrome",
      undefined,
    ]);
  });

  it("rejects link/accent text and unresolved input but allows reset borders and neutral disclosures", () => {
    const rows = scan(
      `const a=<Base className={s.link}/>; const b=<Base className={unknown}/>; const c=<Base className={s.row}/>;`,
      `
      .link {color:var(--link-color);border:none;background:transparent}
      .row {color:var(--text-secondary);background:var(--bg-hover);border:0}
    `,
    );
    expect(rows.map(buttonBaseStyleReason)).toEqual([
      "link/accent text without chrome",
      "unresolved classes or styles",
      undefined,
    ]);
  });

  it("keeps state-dependent variable paints rather than only the last value", () => {
    const rows = scan(
      `const a=<Base className={s.box}/>; const b=<Base className={s.clear}/>;`,
      `
      .box {--fill:red;border:1px solid grey;background:var(--fill)}
      .box:disabled {--fill:transparent}
      .clear {--fill:none;border:1px solid grey;background:var(--fill)}
      .clear:hover {--fill:transparent}
    `,
    );
    expect(rows.map(buttonBaseStyleReason)).toEqual([
      "background and border",
      undefined,
    ]);
  });

  it("ratchets counts without recording an increase or accepting empty reasons", () => {
    const rows = scan(
      `const a=<Base className={s.link}/>;`,
      ".link {color:var(--link-color)}",
    );
    const allowance = {
      "Page.tsx": { count: 2, reason: "Reviewed rich preview" },
    };
    expect(checkButtonBaseAllowlist(rows, allowance).problems).toHaveLength(1);
    expect(
      checkButtonBaseAllowlist(rows, allowance, true).next["Page.tsx"]?.count,
    ).toBe(1);
    expect(checkButtonBaseAllowlist(rows, {}, true).problems).toHaveLength(1);
    expect(
      checkButtonBaseAllowlist(
        rows,
        { "Page.tsx": { count: 1, reason: "" } },
        true,
      ).problems,
    ).toHaveLength(1);
    expect(checkButtonBaseAllowlist([], allowance, true).next).toEqual({});
  });
});

it("rejects a filled, rounded, padded borderless chip", () => {
  expect(
    scan(
      `const a=<Base className={s.chip}/>;`,
      `.chip {background:red;border:0;border-radius:4px;padding:2px 6px}`,
    ).map(buttonBaseStyleReason),
  ).toEqual(["filled rounded padded chip"]);
});
it("recognizes painted zero-blur rings with color before or after the lengths", () => {
  expect(
    scan(
      `const a=<Base className={s.chip}/>; const b=<Base className={s.first}/>; const c=<Base className={s.clear}/>;`,
      `
    .chip {background:red;box-shadow:0 0 0 1px grey}
    .first {box-shadow:var(--link-color) 0 0 0 1px inset}
    .clear {box-shadow:0 0 0 1px transparent}
  `,
    ).map(buttonBaseStyleReason),
  ).toEqual(["background and border", "box-shadow border ring", undefined]);
});

it("recognizes underlined inherited-color text actions", () => {
  expect(
    scan(
      `const a=<Base className={s.link}/>;`,
      `.link {color:inherit;text-decoration:underline}`,
    ).map(buttonBaseStyleReason),
  ).toEqual(["link/accent text without chrome"]);
});
it("does not count transparent border shorthand as paint", () => {
  expect(
    scan(
      `const a=<Base className={s.row}/>;`,
      `.row {background:red;border:1px solid transparent}`,
    ).map(buttonBaseStyleReason),
  ).toEqual([undefined]);
});

it("parses border colors without confusing RGB channels or color-mix with transparency", () => {
  const rows = scan(
    `const a=<Base className={s.rgb}/>; const b=<Base className={s.alpha}/>; const c=<Base className={s.mix}/>;`,
    `
  .rgb {background:red;border:1px solid rgb(255, 0, 0)}
  .alpha {background:red;border:1px solid rgba(255, 0, 0, 0)}
  .mix {background:red;border:1px solid color-mix(in srgb, red 50%, transparent)}
  `,
  );
  expect(rows.map(buttonBaseStyleReason)).toEqual([
    "background and border",
    undefined,
    "background and border",
  ]);
});
