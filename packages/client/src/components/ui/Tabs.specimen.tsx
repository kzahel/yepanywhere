import { type CSSProperties, useId, useState } from "react";
import type { SpecimenMeta } from "../../../design/specimen";
import { TabPanel, Tabs } from "./Tabs";

export default {
  title: "Controls/Tabs",
  component: Tabs,
  parameters: {
    layer: "control",
    description:
      "Tabs from components/ui/Tabs.tsx: a WAI-ARIA tab strip with roving focus, underline or pill look, counts and icons; TabPanel labels its pane.",
  },
} satisfies SpecimenMeta;

const column: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  width: "min(28rem, 100%)",
};

type Mode = "changes" | "files" | "comments" | "reviews";

function Sample({ variant }: { variant: "underline" | "pill" }) {
  const id = useId();
  const [tab, setTab] = useState<Mode>("changes");
  return (
    <div style={column}>
      <Tabs
        id={id}
        variant={variant}
        aria-label="Source control"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "changes", label: "Changes", count: 4 },
          { value: "files", label: "Files" },
          { value: "comments", label: "Comments", count: 12 },
          { value: "reviews", label: "Reviews", disabled: true },
        ]}
      />
      <TabPanel tabsId={id} value={tab}>
        <span style={{ color: "var(--text-secondary)" }}>Pane: {tab}</span>
      </TabPanel>
    </div>
  );
}

export function Underline() {
  return <Sample variant="underline" />;
}

export function Pill() {
  return <Sample variant="pill" />;
}

export function Fill() {
  const [tab, setTab] = useState("model");
  return (
    <div style={column}>
      <Tabs
        layout="fill"
        aria-label="Panel"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "model", label: "Model" },
          { value: "info", label: "Info", icon: "✓" },
        ]}
      />
    </div>
  );
}
