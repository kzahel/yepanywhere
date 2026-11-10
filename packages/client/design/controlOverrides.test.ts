// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkControlAllowlist } from "./controlOverrideAllowlist";
import {
  analyzeControlOverrides,
  controlClassRules,
  type OwnershipSource,
} from "./controlOverrides";

const root = "/controls-fixture";
function scan(text: string, css: string, extra: OwnershipSource[] = []) {
  return analyzeControlOverrides(root, [
    {
      file: "Page.tsx",
      text: `import { Button as Action, IconButton, buttonClassName } from './components/ui/Button'; import styles from './Page.module.css'; ${text}`,
    },
    { file: "Page.module.css", text: css },
    ...extra,
  ]);
}

describe("caller control classes", () => {
  it("resolves aliases, conditional templates, clsx object keys and literal global tokens", () => {
    const result = scan(
      `
      const tone = flag ? 'hot' : 'cold';
      const classes = clsx(styles.box, { [styles.active]: flag });
      const a = <Action className={classes}/>;
      const b = <IconButton className={\`global-\${tone} \${flag ? styles.active : ''}\`}/>;
      const c = buttonClassName({ className: styles.box });
      const unrelated = <OtherButton className={styles.box}/>;
    `,
      `.box { margin: 0; width: 20px; padding-inline: 1px } @media (width < 500px) { .active:hover { opacity: .5 } }`,
      [
        {
          file: "styles/global.css",
          text: ".global-hot { background-size: cover } .global-cold { color: blue }",
        },
      ],
    );
    expect(result.overrides).toHaveLength(3);
    expect(result.overrides[1]?.classes).toEqual(
      expect.arrayContaining([
        ".global-hot",
        ".global-cold",
        "Page.module.css:.active",
      ]),
    );
  });

  it("follows destructured and props.className forwarding across imported wrappers without mixing scopes", () => {
    const result = scan(
      `
      import { Wrapper, PropWrapper, MemoWrapper } from './Wrapper';
      const a = <Wrapper className={styles.box}/>;
      const b = <PropWrapper className="global"/>;
      const c = <MemoWrapper className={styles.box}/>;
      function Unrelated() { const className = 'innocent'; return <Action className={className}/>; }
    `,
      ".box { border-radius: 2px }",
      [
        {
          file: "components/ui/Button.tsx",
          text: "export function Button(props: any) { return null; }",
        },
        {
          file: "Wrapper.tsx",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source must retain interpolation for the parser.
          text: "import { Button } from './components/ui/Button'; export function Wrapper({ className: layout }: any) { return <Button className={`own ${layout} suffix`}/>; } export const PropWrapper = (props: any) => <Button className={props.className}/>; export const MemoWrapper = memo((props: any) => { const { className } = props; return <Button className={className}/>; });",
        },
        { file: "styles/global.css", text: ".global { font-weight: bold }" },
      ],
    );
    expect(
      result.overrides.map(({ file, classes }) => ({ file, classes })),
    ).toEqual([
      { file: "Page.tsx", classes: ["Page.module.css:.box"] },
      { file: "Page.tsx", classes: [".global"] },
      { file: "Page.tsx", classes: ["Page.module.css:.box"] },
    ]);
  });

  it("keeps module identities separate and finds global interop, descendants and states", () => {
    const result = scan(
      "const a = <Action className={styles.box}/>; const b = <Action className='interop'/>;",
      ".box { margin: 0 } .box > svg { height: 12px } .root :global(.interop):focus { outline: 0 }",
      [{ file: "Other.module.css", text: ".box { color: red }" }],
    );
    expect(result.overrides).toHaveLength(2);
    expect(result.overrides[0]?.rules).toHaveLength(1);
    expect(result.overrides[0]?.rules[0]?.properties).toEqual(["height"]);
  });

  it("resolves whole helper class expressions, shorthand objects, spreads and finite module keys", () => {
    const result = scan(
      `
      const className = styles.box;
      const options = { className };
      const props = { ...options };
      const a = <a className={clsx(buttonClassName(options), 'extra')}/>;
      const b = <Action {...props}/>;
      function Dynamic({kind}: {kind: 'box' | 'other'}) { return <Action className={styles[kind]}/>; }
    `,
      ".box { color: red } .other { padding: 1px }",
      [{ file: "styles/global.css", text: ".extra { opacity: .5 }" }],
    );
    expect(result.overrides).toHaveLength(3);
    expect(result.overrides[0]?.classes).toEqual(
      expect.arrayContaining(["Page.module.css:.box", ".extra"]),
    );
    expect(result.overrides[2]?.classes).toEqual(
      expect.arrayContaining([
        "Page.module.css:.box",
        "Page.module.css:.other",
      ]),
    );
  });

  it("includes state classes appended by the wrapper consuming buttonClassName", () => {
    const result = scan(
      `import {CopyWrap} from './Wrapper'; const classes=buttonClassName({className:styles.box}); const a=<CopyWrap className={classes}/>;`,
      `.box.copied {color:green}`,
      [
        {
          file: "Wrapper.tsx",
          text: "import {ButtonBase} from './components/ui/Button'; export const CopyWrap=memo(function Inner({className}) {return <ButtonBase className={className + (copied ? ' copied' : '')}/>});",
        },
      ],
    );
    expect(result.overrides).toHaveLength(1);
    expect(result.overrides[0]?.control).toBe("buttonClassName");
  });

  it("expands nested rules and rejects child styling, but not anchor-only rules on a button", () => {
    const result = scan(
      `const a=<Action className="launcher"/>; const b=<Action className={styles.box}/>; const c=buttonClassName({className:"button-only"});`,
      ".box { @media (width < 500px) { &:hover { background: red } } svg { height: 10px } } .row :global(a.launcher) { min-height: 36px }",
      [
        {
          file: "styles/global.css",
          text: "a.launcher { border: 0 } button.button-only { color: red }",
        },
      ],
    );
    expect(result.overrides).toHaveLength(2);
    expect(
      result.overrides[0]?.rules.map(({ properties }) => properties),
    ).toEqual([["background"], ["height"]]);
    expect(result.overrides[1]?.control).toBe("buttonClassName");
  });

  it("ignores negated/relational classes and unrelated siblings, and allows layout/truncation", () => {
    const rules = controlClassRules(
      "x.module.css",
      `
      .layout { margin: 0; flex: 1; width: 20px; max-width: 100%; gap: 2px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; visibility: hidden }
      .root:not(.negated):has(.related) { color: red }
      .before + .subject { background: red }
      .before ~ .last .child { font-size: 10px }
      .root:is(.active, .other):hover::before { padding: 1px }
    `,
    );
    expect(new Set(rules.map(({ name }) => name))).toEqual(
      new Set(["root", "subject", "last", "child", "active", "other"]),
    );
  });

  it("checks non-button controls and dedicated class props without treating ButtonBase as a shared look", () => {
    const result = scan(
      `import { TextInput } from './components/ui/Field'; import { Dialog } from './components/ui/Dialog'; import { Radio } from './components/ui/Checkbox'; const a=<TextInput inputClassName={styles.box}/>; const b=<Dialog bodyClassName={styles.box}/>; const c=<Radio className={styles.box}/>; const d=<ButtonBase className={styles.box}/>;`,
      ".box { line-height: 1; text-decoration-line: underline; max-height: 30px }",
    );
    expect(result.overrides.map(({ control }) => control)).toEqual([
      "TextInput",
      "Dialog",
      "Radio",
    ]);
  });
  it("derives custom-property overrides from each control module's var reads", () => {
    const result = scan(
      `import { Badge } from './components/ui/Badge'; const a=<Badge className={styles.patient}/>; const b=<Action className={styles.patient}/>;`,
      `.patient { --badge-color: orange; --unread: red; --button-ink: blue }`,
      [
        {
          file: "components/ui/Badge.module.css",
          text: ".badge {color:var(--badge-color);background:var(--badge-soft)}",
        },
        {
          file: "components/ui/Button.module.css",
          text: ".button {color:var(--button-ink)}",
        },
      ],
    );
    expect(
      result.overrides.map((row) =>
        row.rules.flatMap((rule) => rule.properties),
      ),
    ).toEqual([["--badge-color"], ["--button-ink"]]);
  });

  it("evaluates helper returns and useMemo callbacks and fails closed on unknown expressions", () => {
    const result = scan(
      `function cls(on) { if(on) return styles.hot; return styles.cold; } const a=<Action className={cls(on)}/>; const b=<Action className={useMemo(() => flag ? styles.hot : styles.cold, [flag])}/>; const c=<Action className={external(on)}/>; const d=<Action className={unknown}/>;`,
      `.hot {color:red} .cold {padding:2px}`,
    );
    expect(result.overrides).toHaveLength(4);
    for (const row of result.overrides.slice(0, 2))
      expect(row.classes).toEqual(
        expect.arrayContaining([
          "Page.module.css:.hot",
          "Page.module.css:.cold",
        ]),
      );
    for (const row of result.overrides.slice(2))
      expect(row.rules[0]?.properties).toEqual(["unresolved className"]);
  });

  it("fails closed for unresolved computed module and object keys", () => {
    const result = scan(
      `const classes={hot:styles.hot}; const a=<Action className={styles[externalKey]}/>; const b=<Action className={classes[externalKey]}/>;`,
      `.hot {color:red}`,
    );
    expect(result.overrides).toHaveLength(2);
    expect(
      result.overrides.every((row) =>
        row.classes.includes("<unresolved className>"),
      ),
    ).toBe(true);
  });

  it("resolves named memo and forwardRef wrappers by the exported binding", () => {
    const result = scan(
      `import { W, R } from './Wrapper'; const a=<W className={styles.box}/>; const b=<R className={styles.box}/>;`,
      `.box {color:red}`,
      [
        {
          file: "components/ui/Button.tsx",
          text: "export function Button() {return null}",
        },
        {
          file: "Wrapper.tsx",
          text: `import {Button} from './components/ui/Button'; export const W=memo(function Inner({className}) {return <Button className={className}/>}); export const R=forwardRef(function RefInner({className},ref) {return <Button className={className} ref={ref}/>});`,
        },
      ],
    );
    expect(result.overrides).toHaveLength(2);
    expect(result.overrides.every((row) => row.file === "Page.tsx")).toBe(true);
  });

  it("finds ancestor rules reaching controls but excludes other elements and supplied child icons", () => {
    const result = scan(
      `const a=<div className={styles.wrap}><Action/><IconButton className={styles.icon}><svg className={styles.glyph}/></IconButton><div><Action/></div></div>;`,
      `.wrap button {color:red} .wrap > * {padding:2px} .wrap :is(a,summary) {font-size:20px} .wrap [data-other] {filter:blur(2px)} .icon svg {height:12px} .icon .glyph {fill:red}`,
    );
    expect(result.overrides).toHaveLength(3);
    expect(result.overrides[0]?.rules.map((rule) => rule.properties)).toEqual([
      ["color"],
      ["padding"],
    ]);
    expect(result.overrides[1]?.rules.map((rule) => rule.properties)).toEqual([
      ["color"],
      ["padding"],
    ]);
    expect(result.overrides[2]?.rules.map((rule) => rule.properties)).toEqual([
      ["color"],
    ]);
  });

  it("exempts caller-owned icons supplied by component or option props", () => {
    const result = scan(
      `import { SegmentedControl } from './components/ui/SegmentedControl'; function OwnIcon(){return <svg/>} const a=<IconButton className={styles.icon}><OwnIcon/></IconButton>; const b=<SegmentedControl className={styles.options} options={[{icon:<span className={styles.glyph}/>}]}/>;`,
      `.icon svg {height:12px} .options [aria-checked=true] .glyph {background:red}`,
    );
    expect(result.overrides).toHaveLength(0);
  });

  it("counts transform, filter, shadow and SVG paint, including inline styles", () => {
    const result = scan(
      `const a=<Action className={styles.box}/>; const b=<Action style={{color:'red',paddingInline:2,opacity:1,margin:4,transform:'scale(2)'}}/>;`,
      `.box {transform:scale(2);filter:blur(2px);text-shadow:0 0 red;fill:red;stroke:blue}`,
    );
    expect(result.overrides[0]?.rules[0]?.properties).toEqual([
      "transform",
      "filter",
      "text-shadow",
      "fill",
      "stroke",
    ]);
    expect(
      result.overrides[1]?.rules.flatMap((rule) => rule.properties),
    ).toEqual(["color", "padding-inline", "transform"]);
  });

  it("allows binary reveal behaviour while retaining fractional opacity", () => {
    const result = scan(
      `const a=<Action className={styles.reveal}/>; const b=<Action className={styles.faded}/>;`,
      `.reveal {opacity:0;pointer-events:none;visibility:hidden} .reveal:hover {opacity:1;pointer-events:auto;visibility:visible} .faded {opacity:.55}`,
    );
    expect(result.overrides).toHaveLength(1);
    expect(result.overrides[0]?.classes).toEqual(["Page.module.css:.faded"]);
  });
});

describe("control exception ratchet", () => {
  it("only lowers counted reasons, deletes cleared files and refuses new or increased entries", () => {
    const rows = scan(
      "const a=<Action className={styles.box}/>;",
      ".box { color: red }",
    ).overrides;
    const allowance = {
      buttons: {
        "Page.tsx": { count: 2, reason: "Distinct viewer reload state" },
        "Gone.tsx": { count: 1, reason: "composer pass" },
      },
      controls: {},
    };
    const recorded = checkControlAllowlist(rows, allowance, true);
    expect(recorded.problems).toEqual([]);
    expect(recorded.next.buttons).toEqual({
      "Page.tsx": { count: 1, reason: allowance.buttons["Page.tsx"].reason },
    });
    expect(
      checkControlAllowlist(rows, { buttons: {}, controls: {} }, true).problems,
    ).toHaveLength(1);
    expect(
      checkControlAllowlist(
        [...rows, ...rows],
        {
          buttons: {
            "Page.tsx": { count: 1, reason: "Distinct viewer reload state" },
          },
          controls: {},
        },
        true,
      ).problems,
    ).toHaveLength(1);
    expect(
      checkControlAllowlist(
        rows,
        { buttons: { "Page.tsx": { count: 1, reason: "" } }, controls: {} },
        true,
      ).problems,
    ).toHaveLength(1);
  });
});

it("allows translate-only layout transforms, including calc, but rejects mixed transforms", () => {
  const result = scan(
    `const a=<Action className={styles.center}/>; const b=<Action style={{transform:'translateX(-50%)'}}/>; const c=<Action className={styles.mixed}/>;`,
    `.center {transform:translateX(calc(-50% + var(--offset))) translateY(2px)} .mixed {transform:translateX(-50%) scale(1.2)}`,
  );
  expect(result.overrides).toHaveLength(1);
  expect(result.overrides[0]?.rules[0]?.properties).toEqual(["transform"]);
});
