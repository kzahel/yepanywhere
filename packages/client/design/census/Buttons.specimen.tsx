import { classUsage } from "virtual:ya-design-data";
import type { SpecimenMeta } from "../specimen";
import styles from "./Census.module.css";
import { CensusRow, useModuleClasses } from "./censusParts";
import { isButtonClass, LEGACY_BUTTONS } from "./mapping";
import {
  BUTTON_VARIANTS,
  type ButtonVariant,
  ProposedButton,
} from "./ProposedControls";

export default {
  title: "Census/Buttons",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Every legacy button style beside the proposed canonical variant it maps to. The mapping in design/census/mapping.ts is a proposal until the maintainer confirms it.",
  },
} satisfies SpecimenMeta;

const PLUS = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

export function Proposed() {
  return (
    <div className={styles.census}>
      {[false, true].map((small) => (
        <div key={String(small)} className={styles.variants}>
          {BUTTON_VARIANTS.map((variant) => (
            <div key={variant} className={styles.variantColumn}>
              <span className={styles.variantName}>
                {variant}
                {small ? " · small" : ""}
              </span>
              <ProposedButton variant={variant} small={small}>
                {variant === "danger" || variant === "danger-outline"
                  ? "Delete"
                  : "Save changes"}
              </ProposedButton>
              <ProposedButton variant={variant} small={small} disabled>
                Disabled
              </ProposedButton>
              <ProposedButton variant={variant} small={small} icon label="Add">
                {PLUS}
              </ProposedButton>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
Proposed.storyName = "Proposed variants";

function sampleLabel(to: string) {
  return to === "danger" || to === "danger-outline" ? "Delete" : "Save";
}

export function LegacyByVariant() {
  const groups = [...BUTTON_VARIANTS, "composer"] as const;
  return (
    <div className={styles.census}>
      {groups.map((group) => {
        const rows = LEGACY_BUTTONS.filter((row) => row.to === group);
        if (!rows.length) return null;
        return (
          <section key={group} className={styles.group}>
            <header className={styles.groupHeader}>
              <h3 className={styles.groupTitle}>{group}</h3>
              {group === "composer" ? (
                <span>
                  The composer's own control row; unified as a pattern.
                </span>
              ) : (
                <ProposedButton variant={group as ButtonVariant}>
                  {sampleLabel(group)}
                </ProposedButton>
              )}
            </header>
            <div className={styles.rows}>
              {rows.map((row) => (
                <CensusRow
                  key={row.classes}
                  label={row.classes}
                  counted={row.counted}
                  note={row.note}
                  sample={
                    <button type="button" className={row.classes}>
                      {row.icon ? PLUS : sampleLabel(row.to)}
                    </button>
                  }
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
LegacyByVariant.storyName = "Legacy, by proposed variant";

export function GlobalUnmapped() {
  const mapped = new Set(LEGACY_BUTTONS.map((row) => row.counted));
  const unmapped = Object.entries(classUsage)
    .filter(([name]) => isButtonClass(name) && !mapped.has(name))
    .sort(([, a], [, b]) => b.uses - a.uses);
  return (
    <div className={styles.census}>
      <p className={styles.intro}>
        {unmapped.length} global button classes have no row in the mapping yet.
        Each renders on its own, so a class that depends on a parent selector
        shows only its standalone part. Static counts miss classes assembled at
        runtime; "no static use" is a lead for dead CSS, not proof.
      </p>
      <div className={styles.rows}>
        {unmapped.map(([name, usage]) => (
          <CensusRow
            key={name}
            label={`${name} · ${usage.stylesheets.join(", ")}`}
            counted={name}
            sample={
              <button type="button" className={name}>
                Save
              </button>
            }
          />
        ))}
      </div>
    </div>
  );
}
GlobalUnmapped.storyName = "Global classes, unmapped";

const acceptModuleButton = (name: string) =>
  /button|btn/i.test(name) &&
  !/(?:^|[a-z])(?:Label|Icon|Text|Group|Row|Wrap|Wrapper|Container|List|Actions|Bar|Buttons|Area|Slot)$|^buttons$/.test(
    name,
  );

export function ModuleClasses() {
  const classes = useModuleClasses(acceptModuleButton);
  if (!classes)
    return (
      <p className={styles.loading} data-design-pending="">
        Loading CSS Modules…
      </p>
    );
  return (
    <div className={styles.census}>
      <p className={styles.intro}>
        {classes.length} button classes declared in{" "}
        {new Set(classes.map((entry) => entry.file)).size} CSS Modules. Most are
        reached only through their component and depend on its layout, so this
        shows their standalone part.
      </p>
      <div className={styles.rows}>
        {classes.map((entry) => (
          <CensusRow
            key={`${entry.file}:${entry.name}`}
            label={`${entry.file} .${entry.name}`}
            sample={
              <button type="button" className={entry.className}>
                Save
              </button>
            }
          />
        ))}
      </div>
    </div>
  );
}
ModuleClasses.storyName = "CSS Module classes";
