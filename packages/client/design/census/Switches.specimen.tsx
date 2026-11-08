import { type ReactElement, useState } from "react";
import { classUsage } from "virtual:ya-design-data";
import { AttachmentQualityToggle } from "../../src/components/AttachmentQualityToggle";
import type { AttachmentUploadQuality } from "../../src/hooks/useAttachmentUploadQuality";
import type { SpecimenMeta } from "../specimen";
import styles from "./Census.module.css";
import { CensusRow, useModuleClasses } from "./censusParts";
import {
  isSwitchClass,
  LEGACY_SWITCHES,
  type SwitchDisposition,
} from "./mapping";
import { ProposedSegmented, ProposedSwitch } from "./ProposedControls";

export default {
  title: "Census/Switches and segmented controls",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "On/off switches and one-of-many choices: the legacy markup beside the proposed Switch and SegmentedControl. Mapping is a proposal until confirmed.",
  },
} satisfies SpecimenMeta;

export function Proposed() {
  return (
    <div className={styles.census}>
      <div className={styles.variants}>
        <ProposedSwitch label="Notifications" />
        <ProposedSwitch label="Live output" initial />
        <ProposedSwitch label="Disabled" disabled />
        <ProposedSwitch label="Disabled, on" initial disabled />
      </div>
      <div className={styles.variants}>
        <ProposedSegmented
          label="Font size"
          options={["Small", "Medium", "Large"]}
          initial="Medium"
        />
        <ProposedSegmented
          label="Upload quality"
          options={["SD", "HD"]}
          initial="SD"
        />
        <ProposedSegmented
          label="Disabled"
          options={["One", "Two"]}
          initial="One"
          disabled
        />
      </div>
    </div>
  );
}
Proposed.storyName = "Proposed Switch and SegmentedControl";

/** The pasted settings markup, exactly as the settings pages write it. */
function LegacyToggle({
  initial,
  disabled,
}: {
  initial: boolean;
  disabled?: boolean;
}) {
  const [checked, setChecked] = useState(initial);
  return (
    <label className="toggle-switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => setChecked(event.target.checked)}
      />
      <span className="toggle-slider" />
    </label>
  );
}

function LegacyOptions({
  options,
  initial,
  group,
  option,
}: {
  options: string[];
  initial: string;
  group: string;
  option: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className={group}>
      {options.map((entry) => (
        <button
          key={entry}
          type="button"
          className={`${option} ${entry === value ? "active" : ""}`}
          onClick={() => setValue(entry)}
        >
          {entry}
        </button>
      ))}
    </div>
  );
}

function AttachmentQualitySample() {
  const [quality, setQuality] = useState<AttachmentUploadQuality>("sd");
  return <AttachmentQualityToggle quality={quality} onChange={setQuality} />;
}

const SAMPLES: Record<string, () => ReactElement> = {
  "toggle-switch + toggle-slider": () => (
    <>
      <LegacyToggle initial={false} />
      <LegacyToggle initial />
      <LegacyToggle initial disabled />
    </>
  ),
  "font-size-selector + font-size-option": () => (
    <LegacyOptions
      options={["Small", "Medium", "Large"]}
      initial="Medium"
      group="font-size-selector"
      option="font-size-option"
    />
  ),
  "model-settings-chip-group": () => (
    <LegacyOptions
      options={["Off", "Brief", "Full"]}
      initial="Brief"
      group="font-size-selector model-settings-chip-group"
      option="font-size-option"
    />
  ),
  "model-switch-chip-group + model-switch-chip": () => (
    <LegacyOptions
      options={["Low", "Medium", "High"]}
      initial="Medium"
      group="model-switch-chip-group"
      option="model-switch-chip"
    />
  ),
  AttachmentQualityToggle: () => <AttachmentQualitySample />,
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
        return (
          <section key={disposition} className={styles.group}>
            <header className={styles.groupHeader}>
              <h3 className={styles.groupTitle}>{disposition}</h3>
              {disposition === "switch" ? (
                <ProposedSwitch label="Proposed" initial />
              ) : disposition === "segmented" ? (
                <ProposedSegmented
                  label="Proposed"
                  options={["One", "Two", "Three"]}
                  initial="Two"
                />
              ) : (
                <span>Not a switch; listed so the census accounts for it.</span>
              )}
            </header>
            <div className={styles.rows}>
              {rows.map((row) => {
                const Sample = SAMPLES[row.name];
                return (
                  <CensusRow
                    key={row.name}
                    label={row.name}
                    counted={row.counted}
                    note={row.note}
                    sample={
                      Sample ? (
                        <Sample />
                      ) : (
                        <span className={styles.loading}>No markup sample</span>
                      )
                    }
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
LegacyByProposal.storyName = "Legacy, by proposed control";

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
