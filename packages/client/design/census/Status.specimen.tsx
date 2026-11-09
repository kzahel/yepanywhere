import { type ReactNode, useState } from "react";
import { Badge } from "../../src/components/ui/Badge";
import { Banner } from "../../src/components/ui/Banner";
import { Spinner } from "../../src/components/ui/Spinner";
import { Tabs } from "../../src/components/ui/Tabs";
import type { SpecimenMeta } from "../specimen";
import styles from "./Census.module.css";
import { CensusRow } from "./censusParts";
import { LEGACY_STATUS, type StatusFamily } from "./mapping";

export default {
  title: "Census/Banners, badges, spinners and tabs",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Every legacy banner, notice, badge, spinner and tab strip, in the family's order, and where it went. The family is swept: lint bans the old classes, tab roles outside Tabs and rotating keyframes outside Spinner. The page stays as a regression view.",
  },
} satisfies SpecimenMeta;

function SampleTabs() {
  const [tab, setTab] = useState("changes");
  return (
    <Tabs
      aria-label="Sample"
      value={tab}
      onChange={setTab}
      tabs={[
        { value: "changes", label: "Changes", count: 3 },
        { value: "files", label: "Files" },
      ]}
    />
  );
}

const BECOMES: Record<StatusFamily, () => ReactNode> = {
  banner: () => (
    <Banner tone="warning" role="none">
      Banner
    </Banner>
  ),
  badge: () => <Badge tone="info">Badge</Badge>,
  spinner: () => <Spinner label="Spinner" />,
  tabs: () => <SampleTabs />,
};

function Family({ family }: { family: StatusFamily }) {
  const rows = LEGACY_STATUS.filter((row) => row.family === family);
  const Becomes = BECOMES[family];
  return (
    <div className={styles.census}>
      <section className={styles.group}>
        <header className={styles.groupHeader}>
          <h3 className={styles.groupTitle}>{family}</h3>
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
                  {row.to === family ? "Swept" : "Left"}
                </span>
              }
            />
          ))}
        </div>
      </section>
    </div>
  );
}

export function Banners() {
  return <Family family="banner" />;
}

export function Badges() {
  return <Family family="badge" />;
}

export function Spinners() {
  return <Family family="spinner" />;
}

export function TabStrips() {
  return <Family family="tabs" />;
}
TabStrips.storyName = "Tabs";
