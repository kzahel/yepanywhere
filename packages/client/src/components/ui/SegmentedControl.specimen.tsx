import { type CSSProperties, useState } from "react";
import type { SpecimenMeta } from "../../../design/specimen";
import {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from "./SegmentedControl";

export default {
  title: "Controls/SegmentedControl",
  component: SegmentedControl,
  parameters: {
    layer: "control",
    description:
      "SegmentedControl from components/ui/SegmentedControl.tsx: a radio group, one tab stop, arrow keys select. The segmented look for short labels, the cards look for options with an icon or a description.",
  },
} satisfies SpecimenMeta;

const column: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "var(--space-3)",
  width: "22rem",
};

function Sample<T extends string>({
  initial,
  ...props
}: Omit<SegmentedControlProps<T>, "value" | "onChange"> & {
  initial: T | null;
}) {
  const [value, setValue] = useState<T | null>(initial);
  return <SegmentedControl {...props} value={value} onChange={setValue} />;
}

const SIZES: SegmentedOption<string>[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

const VIEWS: SegmentedOption<string>[] = [
  { value: "source", label: "Source" },
  { value: "preview", label: "Preview" },
  { value: "blame", label: "Blame", disabled: true },
];

function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
      }}
    />
  );
}

const PROVIDERS: SegmentedOption<string>[] = [
  {
    value: "claude",
    label: "Claude",
    icon: <Dot color="var(--app-claude-orange)" />,
  },
  {
    value: "codex",
    label: "Codex",
    icon: <Dot color="var(--success-color)" />,
  },
  { value: "gemini", label: "Gemini", icon: <Dot color="var(--link-color)" /> },
  {
    value: "local",
    label: "Local",
    icon: <Dot color="var(--text-muted)" />,
    disabled: true,
  },
];

const MODES: SegmentedOption<string>[] = [
  {
    value: "default",
    label: "Ask before edits",
    description: "Approve each file change and command.",
  },
  {
    value: "accept",
    label: "Accept edits",
    description: "File changes apply; commands still ask.",
  },
  {
    value: "plan",
    label: "Plan",
    description: "Read and propose, change nothing.",
  },
];

export function Segmented() {
  return (
    <div style={column}>
      <Sample aria-label="Font size" options={SIZES} initial="medium" />
      <Sample aria-label="View" options={VIEWS} initial="source" />
      <Sample aria-label="Nothing selected" options={SIZES} initial={null} />
      <Sample aria-label="Disabled" options={SIZES} initial="small" disabled />
    </div>
  );
}

export function SmallAndFill() {
  return (
    <div style={column}>
      <Sample
        aria-label="Font size"
        options={SIZES}
        initial="large"
        size="small"
      />
      <Sample
        aria-label="Font size"
        options={SIZES}
        initial="medium"
        layout="fill"
      />
    </div>
  );
}
SmallAndFill.storyName = "Small, and filling the row";

export function Cards() {
  return (
    <div style={column}>
      <Sample
        aria-label="Provider"
        variant="cards"
        options={PROVIDERS}
        initial="claude"
      />
      <Sample
        aria-label="Provider"
        variant="cards"
        size="small"
        options={PROVIDERS}
        initial="codex"
      />
      <Sample
        aria-label="Permission mode"
        variant="cards"
        layout="stack"
        options={MODES}
        initial="accept"
      />
    </div>
  );
}
