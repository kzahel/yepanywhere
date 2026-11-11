import { useLayoutEffect } from "react";
import type { ReactNode } from "react";
import { openCensus } from "virtual:ya-design-data";
import purposeDebt from "../../../../scripts/css-architecture-baseline.json";
import externalClasses from "../../../../scripts/css-class-string-allowlist.json";
import buttonBases from "../census/button-base-allowlist.json";
import elements from "../census/button-allowlist.json";
import controls from "../census/control-override-allowlist.json";
import tokens from "../census/token-literal-allowlist.json";
import pageStyles from "../Design.module.css";
import { type DesignRoute, routeHref, viewHref } from "../route";
import { useFontsReady } from "../useFontsReady";
import { AuditRows, AllowanceGroup } from "./AuditRows";
import { ElementExceptions } from "./ElementExceptions";
import styles from "./Audit.module.css";

function total(entries: Record<string, { count: number }>) {
  return Object.values(entries).reduce(
    (count, entry) => count + entry.count,
    0,
  );
}

function Disclosure({
  title,
  count,
  children,
}: {
  title: string;
  count: string;
  children: ReactNode;
}) {
  return (
    <details className={styles.disclosure}>
      <summary>
        <span className={styles.summaryContent}>
          <span>{title}</span>
          <span className={styles.metric}>{count}</span>
        </span>
      </summary>
      <div className={styles.disclosureBody}>{children}</div>
    </details>
  );
}

export function AuditPage({ route }: { route: DesignRoute }) {
  const ready = useFontsReady();
  useLayoutEffect(() => {
    if (ready && route.section)
      document.getElementById(`audit-${route.section}`)?.scrollIntoView();
  }, [ready, route.section]);
  const controlTotal = total(controls.buttons) + total(controls.controls);
  const elementTotal = Object.values(elements).reduce<number>(
    (count, entries) => count + (Array.isArray(entries) ? 0 : total(entries)),
    0,
  );
  const contextTotal = total(purposeDebt.globalPurposeExceptions);
  const cards = [
    {
      id: "migrations",
      title: "Unfinished migrations",
      metric: `${openCensus.composer.length} composer rows`,
      text: "Controls still awaiting the shared-control pass.",
    },
    {
      id: "exceptions",
      title: "Reviewed exceptions",
      metric: `${controlTotal} control overrides · ${total(tokens)} token values`,
      text: "Specific reasons to retain a difference; review before changing it.",
    },
    {
      id: "generated",
      title: "Generated-content boundaries",
      metric: `${openCensus.runtime.length} class families · ${contextTotal} context references`,
      text: "Formatting for rendered Markdown, code and math.",
    },
  ] as const;
  return (
    <main
      className={`${pageStyles.page} ${styles.report}`}
      data-design-ready={ready ? "" : undefined}
    >
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.crumbs}>
          <a href={viewHref("", route)}>Playground</a> / Audit
        </p>
        <h1>Design audit</h1>
        <p className={pageStyles.description}>
          One report for migration work, reviewed exceptions and
          generated-content ownership. Controls and Patterns show the shared
          designs to use.
        </p>
        <p className={styles.intro}>
          Counts describe individual checks and can overlap. A retained
          exception is not automatically unfinished work.
        </p>
      </header>
      <nav className={styles.overview} aria-label="Audit sections">
        {cards.map((card) => (
          <a
            key={card.id}
            className={styles.summaryLink}
            href={routeHref("audit", {
              theme: route.theme,
              phone: route.phone,
              section: card.id,
            })}
          >
            <strong>{card.title}</strong>
            <span className={styles.metric}>{card.metric}</span>
            <span>{card.text}</span>
          </a>
        ))}
      </nav>

      <section id="audit-migrations" className={styles.section}>
        <h2>Unfinished migrations</h2>
        <p className={styles.intro}>
          Composer controls still have an explicit exemption from the
          shared-control migration. Their styles already have module owners.
          Plan 182 covers adoption of shared controls; the report does not
          prescribe a redesign.
        </p>
        <Disclosure
          title="Composer controls"
          count={`${openCensus.composer.length} rows`}
        >
          <p className={styles.intro}>
            Raw buttons and fields, plus counted typography and control
            exceptions. Some rows also appear under reviewed exceptions. Check:{" "}
            <code>pnpm buttons:check</code>.
          </p>
          <AuditRows rows={openCensus.composer} />
        </Disclosure>
      </section>

      <section id="audit-exceptions" className={styles.section}>
        <h2>Reviewed exceptions</h2>
        <p className={styles.intro}>
          Each finding has a recorded reason. Some need a shared API; others
          preserve specialized interaction, typography or recovery behavior.
          Counts may fall when those constraints are resolved.
        </p>
        <Disclosure
          title="Control appearance overrides"
          count={`${controlTotal} findings`}
        >
          <p className={styles.intro}>
            Caller styling beyond layout. Check:{" "}
            <code>pnpm controls:check</code>.
          </p>
          <AllowanceGroup
            title="Button family"
            element="Button / IconButton / buttonClassName"
            entries={controls.buttons}
            close="Use a shared variant when it can preserve the required interaction, then remove the caller override and lower the count."
          />
          <AllowanceGroup
            title="Other shared controls"
            element="Shared control caller class / style"
            entries={controls.controls}
            close="Resolve the recorded constraint through the control API or a layout wrapper, then lower the count."
          />
        </Disclosure>
        <Disclosure
          title="Specialized clickable surfaces"
          count={`${total(buttonBases)} findings`}
        >
          <p className={styles.intro}>
            Rich ButtonBase targets with their own appearance. Check:{" "}
            <code>pnpm buttons:check</code>.
          </p>
          <AllowanceGroup
            title="ButtonBase surfaces"
            element="ButtonBase"
            entries={buttonBases}
            close="Use Button or SelectableCard when it preserves the rich interaction; retain a specialized target while its recorded boundary is necessary."
          />
        </Disclosure>
        <Disclosure
          title="Typography and corner values"
          count={`${total(tokens)} findings`}
        >
          <p className={styles.intro}>
            Values outside the recognized token expressions, including
            independent fallback styling and measured geometry. Check:{" "}
            <code>pnpm tokens:check</code>.
          </p>
          <AllowanceGroup
            title="Type and radius values"
            element="font-size / font / border-radius"
            entries={tokens}
            close="Use a matching semantic token once the recorded constraint is resolved. Preserve independent typography and CSS-free recovery where needed."
          />
        </Disclosure>
        <Disclosure
          title="Elements and interaction boundaries"
          count={`${elementTotal} findings`}
        >
          <p className={styles.intro}>
            Raw elements, semantic roles, document listeners and specialized
            dialog boundaries. Empty categories and permanently banned legacy
            classes are omitted. Check: <code>pnpm buttons:check</code>.
          </p>
          <ElementExceptions />
        </Disclosure>
      </section>

      <section id="audit-generated" className={styles.section}>
        <h2>Generated-content boundaries</h2>
        <p className={styles.intro}>
          Markdown, syntax highlighting and math renderers produce HTML with
          shared styling. These supported boundaries are reference information,
          not a queue of controls to replace.
        </p>
        <Disclosure
          title="Generated HTML class families"
          count={`${openCensus.runtime.length} families · ${openCensus.globalClasses} global classes`}
        >
          <p className={styles.intro}>
            Declared producers and the classes their output uses. Match counts
            can overlap. Check: <code>pnpm css:unused</code>.
          </p>
          <AuditRows rows={openCensus.runtime} />
        </Disclosure>
        <Disclosure
          title="Styles depending on the surrounding view"
          count={`${contextTotal} context references`}
        >
          <p className={styles.intro}>
            For example, paragraphs in a Markdown preview have different spacing
            from transcript prose. These rules style generated descendants using
            their surrounding view. Check: <code>pnpm css:check</code>.
          </p>
          <AuditRows
            rows={Object.entries(purposeDebt.globalPurposeExceptions).map(
              ([key, entry]) => ({
                element: key.replace("generated:context-attribute:", ""),
                where: `${entry.count} context references`,
                reason: entry.reason,
                close:
                  "Keep this boundary while the generated content needs it. Revisit when its producer can own an equivalent scoped surface.",
              }),
            )}
          />
        </Disclosure>
        <Disclosure
          title="External markup recognition"
          count={`${total(externalClasses)} findings`}
        >
          <p className={styles.intro}>
            Clipboard and document handling recognize class names owned by KaTeX
            or Pandoc. Check: <code>pnpm css:classes</code>.
          </p>
          <AuditRows
            rows={Object.entries(externalClasses).map(([key, entry]) => ({
              element: key.slice(key.lastIndexOf(":") + 1),
              where: `${key.slice(0, key.lastIndexOf(":"))} · ${entry.count} finding`,
              reason: entry.reason,
              close:
                "Retain recognition while the external document format requires it.",
            }))}
          />
        </Disclosure>
      </section>
    </main>
  );
}
