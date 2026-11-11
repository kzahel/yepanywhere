import { type CSSProperties, useId, useState } from "react";
import type { SpecimenMeta } from "../../../design/specimen";
import { Checkbox, Radio } from "./Checkbox";
import { Field, Select, Textarea, TextInput } from "./Field";
import { IconButton } from "./Button";

export default {
  title: "Controls/Field",
  component: Field,
  parameters: {
    layer: "control",
    description:
      "Field, TextInput, Textarea and Select from components/ui/Field.tsx, Checkbox and Radio from components/ui/Checkbox.tsx: one box for every text field, a label/hint/error wrapper, and native choices in the accent color.",
  },
} satisfies SpecimenMeta;

const column: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  width: "min(22rem, 100%)",
};

const row: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-3)",
};

export function Adornments() {
  const [value, setValue] = useState("");
  const [choice, setChoice] = useState("plain");
  return (
    <div style={column}>
      <Field
        label="Search"
        hint="Clear remains separate from the text and its focus."
      >
        <TextInput
          value={value}
          onChange={(event) => setValue(event.target.value)}
          leading="⌕"
          trailing={
            value ? (
              <IconButton
                size="small"
                label="Clear search"
                onClick={() => setValue("")}
              >
                ×
              </IconButton>
            ) : null
          }
        />
      </Field>
      <TextInput
        aria-label="Compact decorated field"
        size="small"
        touchTarget="large"
        defaultValue="A long command or source path stays clear of actions"
        trailing={
          <IconButton size="small" label="Field action">
            ?
          </IconButton>
        }
      />
      <Select
        aria-label="Prefix"
        value={choice}
        leading={choice === "icon" ? "●" : null}
        onChange={(event) => setChoice(event.target.value)}
      >
        <option value="plain">Plain prefix</option>
        <option value="icon">Icon prefix</option>
      </Select>
      <Checkbox label="Touch row" touchTarget="large" />
      <Checkbox
        label="Padded choice"
        variant="option"
        description="Clicking anywhere in this row changes the choice."
      />
    </div>
  );
}

export function TextInputs() {
  const [value, setValue] = useState("Typed text");
  return (
    <div style={column}>
      <TextInput
        aria-label="Default"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <TextInput aria-label="Placeholder" placeholder="Placeholder" />
      <TextInput aria-label="Small" size="small" defaultValue="Small" />
      <TextInput
        aria-label="Command"
        mono
        defaultValue="pnpm -s design:shot controls-field"
      />
      <TextInput aria-label="Invalid" invalid defaultValue="not a url" />
      <TextInput aria-label="Read only" readOnly defaultValue="Read only" />
      <TextInput aria-label="Disabled" disabled defaultValue="Disabled" />
      <div style={row}>
        <TextInput
          aria-label="Height"
          type="number"
          unit="px"
          defaultValue={480}
        />
        <TextInput
          aria-label="Seconds"
          type="number"
          size="small"
          unit="s"
          defaultValue={30}
        />
      </div>
    </div>
  );
}

export function Fields() {
  const [url, setUrl] = useState("localhost:8080");
  const invalid = !/^https?:\/\//.test(url);
  return (
    <div style={column}>
      <Field label="Name" hint="Shown in the sidebar and the title bar.">
        <TextInput defaultValue="Yep Anywhere" />
      </Field>
      <Field
        label="Endpoint URL"
        required
        error={invalid ? "Start with http:// or https://." : undefined}
      >
        <TextInput
          type="url"
          mono
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </Field>
      <Field label="Provider">
        <Select defaultValue="claude">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="gateway">Claude Gateway</option>
        </Select>
      </Field>
      <Field label="Notes" hint="Markdown is fine.">
        <Textarea defaultValue={"One line\nAnother line"} />
      </Field>
    </div>
  );
}

export function Selects() {
  return (
    <div style={column}>
      <Select aria-label="Default" defaultValue="b">
        <option value="a">First option</option>
        <option value="b">Second option</option>
      </Select>
      <Select aria-label="Small" size="small" defaultValue="a">
        <option value="a">Small</option>
      </Select>
      <Select aria-label="Disabled" disabled defaultValue="a">
        <option value="a">Disabled</option>
      </Select>
      <Textarea aria-label="Mono" mono defaultValue={'{\n  "key": 1\n}'} />
    </div>
  );
}

export function Choices() {
  const [checked, setChecked] = useState(true);
  const [choice, setChoice] = useState("a");
  // One group per theme cell: the cells share a document.
  const name = useId();
  return (
    <div style={column}>
      <Checkbox
        label="Include archived sessions"
        checked={checked}
        onCheckedChange={setChecked}
      />
      <Checkbox
        label="Also restart the server"
        description="Running sessions reconnect after the restart."
        checked={!checked}
        onCheckedChange={(next) => setChecked(!next)}
      />
      <Checkbox label="Partly selected" indeterminate checked={false} />
      <Checkbox label="Disabled" disabled checked />
      <div style={row}>
        <Checkbox aria-label="Unlabelled" checked onCheckedChange={() => {}} />
        <Radio
          name={name}
          label="First"
          checked={choice === "a"}
          onCheckedChange={() => setChoice("a")}
        />
        <Radio
          name={name}
          label="Second"
          checked={choice === "b"}
          onCheckedChange={() => setChoice("b")}
        />
        <Radio name={name} label="Disabled" disabled />
      </div>
    </div>
  );
}
