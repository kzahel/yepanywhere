import type { ReactNode } from "react";
import { classUsage } from "virtual:ya-design-data";
import {
  BUTTON_VARIANTS,
  Button,
  type ButtonVariant,
  IconButton,
} from "../../src/components/ui/Button";
import type { SpecimenMeta } from "../specimen";
import styles from "./Census.module.css";
import { CensusRow, type ModuleClass, useModuleClasses } from "./censusParts";
import {
  BUTTON_DISPOSITIONS,
  type ButtonDisposition,
  isButtonClass,
  LEGACY_BUTTONS,
  MODULE_BUTTONS,
} from "./mapping";

export default {
  title: "Census/Buttons",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Every legacy button class, global and CSS Module, beside what it becomes. Controls/Button shows the shared variants; the mapping is design/census/mapping.ts.",
  },
} satisfies SpecimenMeta;

const PLUS = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

const DISPOSITION_NOTES: Partial<Record<ButtonDisposition, string>> = {
  base: "Clickable rows, cards, chips and disclosures: ButtonBase, keeping the owner's styles.",
  menu: "Menu items: the menu family (plan 182, family 2).",
  tab: "Tabs: family 5.",
  segmented: "Segmented options: family 3.",
  switch: "On/off switches: family 3.",
  composer: "The session composer's controls: excluded until their own pass.",
  dead: "No production use: the rules are deleted.",
  "not-a-button": "Named like a button but styling something else.",
};

function isVariant(to: ButtonDisposition): to is ButtonVariant {
  return (BUTTON_VARIANTS as readonly string[]).includes(to);
}

function sampleLabel(to: ButtonDisposition) {
  return to === "danger" || to === "danger-outline" ? "Delete" : "Save";
}

/** What a mapped row becomes, rendered with the row's size and shape. */
function Becomes({
  to,
  small,
  icon,
}: {
  to: ButtonDisposition;
  small?: boolean;
  icon?: boolean;
}) {
  if (!isVariant(to)) return null;
  const size = small ? "small" : "default";
  return icon ? (
    <IconButton variant={to} size={size} label="Add">
      {PLUS}
    </IconButton>
  ) : (
    <Button variant={to} size={size}>
      {sampleLabel(to)}
    </Button>
  );
}

function destinationName(row: {
  to: ButtonDisposition;
  small?: boolean;
  icon?: boolean;
}) {
  if (!isVariant(row.to)) return row.to;
  return [row.icon ? "IconButton" : "Button", row.to, row.small ? "small" : ""]
    .filter(Boolean)
    .join(" · ");
}

function Groups<Row extends { to: ButtonDisposition }>({
  rows,
  render,
}: {
  rows: readonly Row[];
  render: (row: Row) => ReactNode;
}) {
  return (
    <>
      {BUTTON_DISPOSITIONS.map((group) => {
        const members = rows.filter((row) => row.to === group);
        if (!members.length) return null;
        return (
          <section key={group} className={styles.group}>
            <header className={styles.groupHeader}>
              <h3 className={styles.groupTitle}>
                {group} ({members.length})
              </h3>
              {isVariant(group) ? (
                <Button variant={group}>{sampleLabel(group)}</Button>
              ) : (
                <span>{DISPOSITION_NOTES[group]}</span>
              )}
            </header>
            <div className={styles.rows}>{members.map(render)}</div>
          </section>
        );
      })}
    </>
  );
}

export function GlobalClasses() {
  return (
    <div className={styles.census}>
      <p className={styles.intro}>
        {LEGACY_BUTTONS.length} global button classes, grouped by what they
        become. Each row shows the legacy class on its own, then the shared
        control with the row's size and shape. A class that depends on a parent
        selector shows only its standalone part.
      </p>
      <Groups
        rows={LEGACY_BUTTONS}
        render={(row) => {
          // A swap batch deletes a class's rules once its uses reach zero.
          const deleted = !classUsage[row.counted];
          return (
            <CensusRow
              key={row.classes + row.counted}
              label={`${row.classes} → ${destinationName(row)}${deleted ? " · rules deleted" : ""}`}
              counted={row.counted}
              note={row.note}
              sample={
                deleted ? (
                  <span className={styles.loading}>rules deleted</span>
                ) : (
                  <button type="button" className={row.classes}>
                    {row.icon ? PLUS : sampleLabel(row.to)}
                  </button>
                )
              }
              becomes={<Becomes {...row} />}
            />
          );
        }}
      />
    </div>
  );
}
GlobalClasses.storyName = "Global classes, by destination";

const acceptModuleButton = (name: string) =>
  /button|btn/i.test(name) &&
  !/(?:^|[a-z])(?:Label|Icon|Text|Group|Row|Wrap|Wrapper|Container|List|Actions|Bar|Buttons|Area|Slot)$|^buttons$/.test(
    name,
  );

function moduleKey(file: string, name: string) {
  return `${file}:${name}`;
}

function useModuleIndex() {
  const classes = useModuleClasses(acceptModuleButton);
  if (!classes) return undefined;
  return new Map(
    classes.map((entry) => [moduleKey(entry.file, entry.name), entry]),
  );
}

function Loading() {
  return (
    <p className={styles.loading} data-design-pending="">
      Loading CSS Modules…
    </p>
  );
}

export function ModuleClasses() {
  const index = useModuleIndex();
  if (!index) return <Loading />;
  return (
    <div className={styles.census}>
      <p className={styles.intro}>
        {MODULE_BUTTONS.length} CSS Module button classes in{" "}
        {new Set(MODULE_BUTTONS.map((row) => row.file)).size} modules, grouped
        by what they become. Most are reached only through their component and
        depend on its layout, so the sample shows their standalone part. Names a
        module only mentions in a :global() selector or a comment have no
        sample.
      </p>
      <Groups
        rows={MODULE_BUTTONS}
        render={(row) => {
          const entry = index.get(moduleKey(row.file, row.name));
          return (
            <CensusRow
              key={moduleKey(row.file, row.name)}
              label={`${row.file} .${row.name} → ${destinationName(row)}`}
              note={row.note}
              sample={
                entry ? (
                  <button type="button" className={entry.className}>
                    {row.icon ? PLUS : sampleLabel(row.to)}
                  </button>
                ) : (
                  <span className={styles.loading}>not exported</span>
                )
              }
              becomes={<Becomes {...row} />}
            />
          );
        }}
      />
    </div>
  );
}
ModuleClasses.storyName = "CSS Module classes, by destination";

function unmappedModules(index: Map<string, ModuleClass>) {
  const mapped = new Set(
    MODULE_BUTTONS.map((row) => moduleKey(row.file, row.name)),
  );
  return [...index.values()].filter(
    (entry) =>
      entry.file !== "components/ui/Button.module.css" &&
      !mapped.has(moduleKey(entry.file, entry.name)),
  );
}

export function Unmapped() {
  const index = useModuleIndex();
  if (!index) return <Loading />;
  const mapped = new Set(LEGACY_BUTTONS.map((row) => row.counted));
  const globals = Object.entries(classUsage)
    .filter(([name]) => isButtonClass(name) && !mapped.has(name))
    .sort(([, a], [, b]) => b.uses - a.uses);
  const modules = unmappedModules(index);
  return (
    <div className={styles.census}>
      <p className={styles.intro}>
        {globals.length + modules.length
          ? `${globals.length} global and ${modules.length} CSS Module button classes have no row in design/census/mapping.ts yet. Assign each a destination.`
          : "Every button class the census finds has a row in design/census/mapping.ts."}{" "}
        Static counts miss classes assembled at runtime; "no static use" is a
        lead for dead CSS, not proof.
      </p>
      <div className={styles.rows}>
        {globals.map(([name, usage]) => (
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
        {modules.map((entry) => (
          <CensusRow
            key={moduleKey(entry.file, entry.name)}
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
Unmapped.storyName = "Unmapped";
