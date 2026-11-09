import { type ReactNode, useState } from "react";
import { Checkbox } from "../../src/components/ui/Checkbox";
import {
  Field,
  Select,
  Textarea,
  TextInput,
} from "../../src/components/ui/Field";
import type { SpecimenMeta } from "../specimen";
import styles from "./Census.module.css";
import { CensusRow } from "./censusParts";
import { type FieldDisposition, LEGACY_FIELDS } from "./mapping";

export default {
  title: "Census/Fields",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Text inputs, selects, textareas and checkboxes. The family is swept: every legacy field class became the shared TextInput, Select, Textarea, Field or Checkbox, and lint bans the old classes, raw field elements and rules that style them. The page stays as a regression view.",
  },
} satisfies SpecimenMeta;

function SampleCheckbox() {
  const [checked, setChecked] = useState(true);
  return (
    <Checkbox label="Checkbox" checked={checked} onCheckedChange={setChecked} />
  );
}

const BECOMES: Record<FieldDisposition, () => ReactNode> = {
  text: () => <TextInput aria-label="TextInput" defaultValue="TextInput" />,
  select: () => (
    <Select aria-label="Select" defaultValue="a">
      <option value="a">Select</option>
    </Select>
  ),
  textarea: () => <Textarea aria-label="Textarea" defaultValue="Textarea" />,
  field: () => (
    <Field label="Field" hint="Label, hint and error around a control.">
      <TextInput defaultValue="" />
    </Field>
  ),
  checkbox: () => <SampleCheckbox />,
  keep: () => <span>Not a field; listed so the census accounts for it.</span>,
  composer: () => <span>The composer's own pass.</span>,
};

const DISPOSITIONS: readonly FieldDisposition[] = [
  "text",
  "select",
  "textarea",
  "field",
  "checkbox",
  "keep",
  "composer",
];

export function LegacyByProposal() {
  return (
    <div className={styles.census}>
      {DISPOSITIONS.map((disposition) => {
        const rows = LEGACY_FIELDS.filter((row) => row.to === disposition);
        if (!rows.length) return null;
        const Becomes = BECOMES[disposition];
        return (
          <section key={disposition} className={styles.group}>
            <header className={styles.groupHeader}>
              <h3 className={styles.groupTitle}>{disposition}</h3>
              <div style={{ width: "min(18rem, 100%)" }}>
                <Becomes />
              </div>
            </header>
            <div className={styles.rows}>
              {rows.map((row) => (
                <CensusRow
                  key={row.name}
                  label={row.name}
                  counted={row.counted}
                  note={row.note}
                  sample={
                    <span className={styles.loading}>
                      {disposition === "keep" || disposition === "composer"
                        ? "Left"
                        : "Swept"}
                    </span>
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
LegacyByProposal.storyName = "Legacy, by shared control";
