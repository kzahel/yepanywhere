import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import baseline from "../../../../scripts/css-architecture-baseline.json";
import indexCss from "../../src/styles/index.css?raw";
import providerColorsCss from "../../src/styles/provider-colors.css?raw";
import type { SpecimenMeta } from "../specimen";
import styles from "./Tokens.module.css";

export default {
  title: "Tokens",
  parameters: {
    layer: "token",
    width: "fill",
    description:
      "Theme custom properties from src/styles/index.css, resolved in each theme's cell, and the properties the app reads but never defines.",
  },
} satisfies SpecimenMeta;

/** Names declared in any of the three theme blocks, in source order. */
function themeTokenNames(): string[] {
  const names = new Set<string>();
  const css = `${indexCss}\n${providerColorsCss}`.replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const block =
    /([^{}]*\[data-theme="(?:verydark|dark|light)"\][^{}]*)\{([^{}]*)\}/g;
  for (const match of css.matchAll(block)) {
    for (const declaration of (match[2] ?? "").matchAll(/(--[\w-]+)\s*:/g)) {
      names.add(declaration[1] ?? "");
    }
  }
  return [...names];
}

const GROUPS: readonly [string, RegExp][] = [
  ["Diff", /^--(?:bg-diff|diff-gutter)/],
  ["Syntax", /^--(?:shiki|diff-shiki)/],
  ["Backgrounds", /^--bg-/],
  ["Text", /^--text-/],
  ["Borders", /^--border-/],
  ["Status badges", /^--status-badge/],
  ["Timeline", /^--timeline/],
  ["Providers", /^--provider-/],
];

function groupTokens(names: string[]) {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const group =
      GROUPS.find(([, pattern]) => pattern.test(name))?.[0] ?? "Semantic";
    groups.set(group, [...(groups.get(group) ?? []), name]);
  }
  return groups;
}

function Swatch({ name }: { name: string }) {
  const fill = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState("");
  useLayoutEffect(() => {
    if (fill.current)
      setValue(getComputedStyle(fill.current).getPropertyValue(name).trim());
  }, [name]);
  return (
    <div className={styles.swatch}>
      <span className={styles.chip}>
        <span
          ref={fill}
          className={styles.chipFill}
          style={{ background: `var(${name})` }}
        />
      </span>
      <span className={styles.label}>
        <code>{name}</code>
        <span className={styles.value}>{value || "—"}</span>
      </span>
    </div>
  );
}

export function Colors() {
  const groups = groupTokens(themeTokenNames());
  return (
    <div className={styles.tokens}>
      {[...groups].map(([group, names]) => (
        <section key={group} className={styles.group}>
          <h3>{group}</h3>
          <div className={styles.swatches}>
            {names.map((name) => (
              <Swatch key={name} name={name} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
Colors.storyName = "Theme colors";

function rootTokens(pattern: RegExp): string[] {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(indexCss)?.[1] ?? "";
  return [...root.matchAll(/(--[\w-]+)\s*:/g)]
    .map((match) => match[1] ?? "")
    .filter((name) => pattern.test(name));
}

export function Scales() {
  return (
    <div className={styles.tokens}>
      <section className={styles.group}>
        <h3>Spacing</h3>
        <div className={styles.scale}>
          {rootTokens(/^--space-\d+$/).map((name) => (
            <ScaleRow key={name} name={name}>
              <span className={styles.bar} style={{ width: `var(${name})` }} />
            </ScaleRow>
          ))}
        </div>
      </section>
      <section className={styles.group}>
        <h3>Radius</h3>
        <div className={styles.scale}>
          {rootTokens(/^--radius-/).map((name) => (
            <ScaleRow key={name} name={name}>
              <span
                className={styles.box}
                style={{ borderRadius: `var(${name})` }}
              />
            </ScaleRow>
          ))}
        </div>
      </section>
      <section className={styles.group}>
        <h3>Type</h3>
        <div className={styles.scale}>
          {rootTokens(/^--font-size-(?:xs|sm|base|lg)$/).map((name) => (
            <ScaleRow key={name} name={name}>
              <span style={{ fontSize: `var(${name})` }}>
                Session started in yep-anywhere
              </span>
            </ScaleRow>
          ))}
        </div>
      </section>
    </div>
  );
}
Scales.storyName = "Spacing, radius and type";

function ScaleRow({ name, children }: { name: string; children: ReactNode }) {
  const probe = useRef<HTMLElement>(null);
  const [value, setValue] = useState("");
  useLayoutEffect(() => {
    if (probe.current)
      setValue(getComputedStyle(probe.current).getPropertyValue(name).trim());
  }, [name]);
  return (
    <>
      <code ref={probe}>{name}</code>
      <span className={styles.value}>{value}</span>
      <span>{children}</span>
    </>
  );
}

const stylesheets = import.meta.glob<string>("../../src/**/*.css", {
  query: "?raw",
  import: "default",
});

interface Site {
  path: string;
  line: number;
  fallback: boolean;
}

/** CSS-only sites for each recorded name; TypeScript reads are not listed. */
function useUndefinedSites(names: readonly string[]) {
  const [sites, setSites] = useState<Map<string, Site[]>>();
  useEffect(() => {
    let live = true;
    const wanted = new Set(names);
    void Promise.all(
      Object.entries(stylesheets).map(async ([path, load]) => ({
        path: path.replace(/^\.\.\/\.\.\/src\//, ""),
        text: await load(),
      })),
    ).then((sources) => {
      const found = new Map<string, Site[]>();
      for (const source of sources) {
        source.text.split("\n").forEach((line, index) => {
          for (const match of line.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
            const name = match[1] ?? "";
            if (!wanted.has(name)) continue;
            found.set(name, [
              ...(found.get(name) ?? []),
              { path: source.path, line: index + 1, fallback: !!match[2] },
            ]);
          }
        });
      }
      if (live) setSites(found);
    });
    return () => {
      live = false;
    };
  }, [names]);
  return sites;
}

const recorded = Object.entries(
  (baseline as { undefinedCustomProperties?: Record<string, number> })
    .undefinedCustomProperties ?? {},
).sort(([, a], [, b]) => b - a);
const recordedNames = recorded.map(([name]) => name);

export function Undefined() {
  const sites = useUndefinedSites(recordedNames);
  return (
    <div className={styles.tokens}>
      <p className={styles.intro}>
        {recorded.length} custom properties are read with <code>var()</code> but
        defined by no client source; counts are the limits{" "}
        <code>pnpm css:check</code> holds in{" "}
        <code>scripts/css-architecture-baseline.json</code>. A read with a
        fallback silently uses it; a read without one drops its declaration
        (shown in red). The chip renders <code>var(name)</code> as written.
      </p>
      {sites ? (
        <div className={styles.undefinedTable}>
          {recorded.map(([name, count]) => {
            const found = sites.get(name) ?? [];
            const bare = found.filter((site) => !site.fallback).length;
            return (
              <UndefinedRow
                key={name}
                name={name}
                count={count}
                bare={bare}
                found={found}
              />
            );
          })}
        </div>
      ) : (
        <p className={styles.loading} data-design-pending="">
          Scanning stylesheets…
        </p>
      )}
    </div>
  );
}
Undefined.storyName = "Undefined properties";

function UndefinedRow({
  name,
  count,
  bare,
  found,
}: {
  name: string;
  count: number;
  bare: number;
  found: Site[];
}) {
  return (
    <>
      <span className={styles.chip}>
        <span
          className={styles.chipFill}
          style={{ background: `var(${name})` }}
        />
      </span>
      <code>{name}</code>
      <span className={bare ? styles.noFallback : styles.value}>
        {count} read{count === 1 ? "" : "s"}
        {bare ? `, ${bare} without fallback` : ""}
      </span>
      <span className={styles.sites}>
        {found
          .slice(0, 3)
          .map((site) => `${site.path}:${site.line}`)
          .join("  ")}
        {found.length > 3 ? `  +${found.length - 3} more` : ""}
        {found.length === 0 ? "read from TypeScript only" : ""}
      </span>
    </>
  );
}
