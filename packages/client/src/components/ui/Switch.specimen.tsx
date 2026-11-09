import { type CSSProperties, useState } from "react";
import type { SpecimenMeta } from "../../../design/specimen";
import { Switch } from "./Switch";

export default {
  title: "Controls/Switch",
  component: Switch,
  parameters: {
    layer: "control",
    description:
      "Switch from components/ui/Switch.tsx: a checkbox with role=switch on the legacy 44×24 track. Name it with label, or aria-label when the row names it.",
  },
} satisfies SpecimenMeta;

const column: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "var(--space-3)",
};

function Sample({
  initial,
  ...props
}: {
  initial: boolean;
  label?: string;
  labelPosition?: "start" | "end";
  disabled?: boolean;
}) {
  const [checked, setChecked] = useState(initial);
  return (
    <Switch
      {...props}
      aria-label={props.label ? undefined : "Sample switch"}
      checked={checked}
      onCheckedChange={setChecked}
    />
  );
}

export function States() {
  return (
    <div style={column}>
      <Sample initial={false} />
      <Sample initial />
      <Sample initial={false} disabled />
      <Sample initial disabled />
    </div>
  );
}

export function WithLabel() {
  return (
    <div style={column}>
      <Sample initial label="Notifications" />
      <Sample initial={false} label="Live output" />
      <Sample initial label="Label first" labelPosition="start" />
      <Sample initial={false} label="Disabled" disabled />
    </div>
  );
}
WithLabel.storyName = "With a visible label";
