import { type ReactNode, useState } from "react";
import { classUsage } from "virtual:ya-design-data";
import {
  SegmentedControl,
  type SegmentedOption,
} from "../../src/components/ui/SegmentedControl";
import { Switch } from "../../src/components/ui/Switch";
import type { SpecimenMeta } from "../specimen";
import styles from "./Census.module.css";
import { CensusRow, useModuleClasses } from "./censusParts";
import {
  isSwitchClass,
  LEGACY_SWITCHES,
  type SwitchDisposition,
} from "./mapping";

export default {
  title: "Census/Switches and segmented controls",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "On/off switches and one-of-many choices. The family is swept: every legacy row became the shared Switch or SegmentedControl, and lint bans the old classes. The page stays as a regression view.",
  },
} satisfies SpecimenMeta;

function SampleSwitch({ initial, label }: { initial: boolean; label: string }) {
  const [checked, setChecked] = useState(initial);
  return (
    <Switch label={label} checked={checked} onCheckedChange={setChecked} />
  );
}

function SampleSegmented({
  label,
  options,
  initial,
  variant,
}: {
  label: string;
  options: readonly string[];
  initial: string;
  variant?: "segmented" | "cards";
}) {
  const [value, setValue] = useState(initial);
  const choices: SegmentedOption<string>[] = options.map((option) => ({
    value: option,
    label: option,
  }));
  return (
    <SegmentedControl
      aria-label={label}
      variant={variant}
      options={choices}
      value={value}
      onChange={setValue}
    />
  );
}

export function Shared() {
  return (
    <div className={styles.census}>
      <div className={styles.variants}>
        <SampleSwitch label="Notifications" initial={false} />
        <SampleSwitch label="Live output" initial />
      </div>
      <div className={styles.variants}>
        <SampleSegmented
          label="Font size"
          options={["Small", "Medium", "Large"]}
          initial="Medium"
        />
        <SampleSegmented
          label="Provider"
          options={["Claude", "Codex", "Gemini"]}
          initial="Codex"
          variant="cards"
        />
      </div>
    </div>
  );
}
Shared.storyName = "Shared Switch and SegmentedControl";

const BECOMES: Record<SwitchDisposition, () => ReactNode> = {
  switch: () => <SampleSwitch label="Switch" initial />,
  segmented: () => (
    <SampleSegmented
      label="SegmentedControl"
      options={["One", "Two", "Three"]}
      initial="Two"
    />
  ),
  keep: () => <span>Not a switch; listed so the census accounts for it.</span>,
};

const DISPOSITIONS: readonly SwitchDisposition[] = [
  "switch",
  "segmented",
  "keep",
];

export function LegacyByProposal() {
  return (
    <div className={styles.census}>
      {DISPOSITIONS.map((disposition) => {
        const rows = LEGACY_SWITCHES.filter((row) => row.to === disposition);
        if (!rows.length) return null;
        const Becomes = BECOMES[disposition];
        return (
          <section key={disposition} className={styles.group}>
            <header className={styles.groupHeader}>
              <h3 className={styles.groupTitle}>{disposition}</h3>
              <Becomes />
            </header>
            <div className={styles.rows}>
              {rows.map((row) => (
                <CensusRow
                  key={row.name}
                  label={row.name}
                  counted={row.counted}
                  note={row.note}
                  sample={<span className={styles.loading}>Swept</span>}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
LegacyByProposal.storyName = "Legacy, by shared control";

export function GlobalUnmapped() {
  const mapped = new Set(LEGACY_SWITCHES.map((row) => row.counted));
  const unmapped = Object.entries(classUsage)
    .filter(([name]) => isSwitchClass(name) && !mapped.has(name))
    .sort(([, a], [, b]) => b.uses - a.uses);
  return (
    <div className={styles.census}>
      <p className={styles.intro}>
        {unmapped.length} global switch, toggle, option and chip classes have no
        row in the mapping. Most are parts of a larger control (a label, a
        track, a group); they are listed so none goes unaccounted.
      </p>
      <div className={styles.rows}>
        {unmapped.map(([name, usage]) => (
          <CensusRow
            key={name}
            label={`${name} · ${usage.stylesheets.join(", ")}`}
            counted={name}
            sample={
              <button type="button" className={name}>
                Option
              </button>
            }
          />
        ))}
      </div>
    </div>
  );
}
GlobalUnmapped.storyName = "Global classes, unmapped";

const acceptModuleSwitch = (name: string) =>
  /switch|toggle|segment|chip|radio|option/i.test(name) &&
  !/(Label|Icon|Text|Group|Row|Wrap|Wrapper|Container|List|Bar|Area|Hint|Note|Description|Title|Meta|Detail)$/.test(
    name,
  );

export function ModuleClasses() {
  const classes = useModuleClasses(acceptModuleSwitch);
  if (!classes)
    return (
      <p className={styles.loading} data-design-pending="">
        Loading CSS Modules…
      </p>
    );
  return (
    <div className={styles.census}>
      <p className={styles.intro}>
        {classes.length} switch, toggle, option and chip classes declared in{" "}
        {new Set(classes.map((entry) => entry.file)).size} CSS Modules, each
        shown standalone on a button. Many are segments of a group whose
        container class supplies the frame.
      </p>
      <div className={styles.rows}>
        {classes.map((entry) => (
          <CensusRow
            key={`${entry.file}:${entry.name}`}
            label={`${entry.file} .${entry.name}`}
            sample={
              <button type="button" className={entry.className}>
                Option
              </button>
            }
          />
        ))}
      </div>
    </div>
  );
}
ModuleClasses.storyName = "CSS Module classes";
