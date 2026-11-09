import type { SpecimenMeta } from "../specimen";
import styles from "./Census.module.css";
import { CensusRow } from "./censusParts";
import {
  CONFIRM_CALLS,
  type DialogDisposition,
  LEGACY_DIALOGS,
} from "./mapping";

export default {
  title: "Census/Dialogs",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Every Modal caller and hand-rolled modal with its shape at census time, and where it went: forms, choices and confirmations onto Dialog, viewers left on Modal, a few hand-rolled surfaces kept. Then every window.confirm, now confirmDialog(). Lint bans window.confirm, aria-modal outside Modal and the old footer classes. Capture Controls/Dialog states to see the new boxes.",
  },
} satisfies SpecimenMeta;

const HEADINGS: Record<DialogDisposition, string> = {
  dialog: "Dialog: forms, choices and notices",
  viewer: "Viewers: stay on Modal",
  keep: "Kept: hand-rolled on purpose",
};

function Group({ to }: { to: DialogDisposition }) {
  return (
    <section className={styles.group}>
      <header className={styles.groupHeader}>
        <h3 className={styles.groupTitle}>{HEADINGS[to]}</h3>
      </header>
      <div className={styles.rows}>
        {LEGACY_DIALOGS.filter((row) => row.to === to).map((row) => (
          <CensusRow
            key={row.file}
            label={row.file}
            counted={row.classes?.split(" ")[0]}
            note={`${row.name}. ${row.shape}`}
            sample={<span className={styles.loading}>{to}</span>}
          />
        ))}
      </div>
    </section>
  );
}

export function Modals() {
  return (
    <div className={styles.census}>
      <Group to="dialog" />
      <Group to="viewer" />
      <Group to="keep" />
    </div>
  );
}

export function Confirmations() {
  return (
    <div className={styles.census}>
      <section className={styles.group}>
        <header className={styles.groupHeader}>
          <h3 className={styles.groupTitle}>window.confirm → confirmDialog</h3>
        </header>
        <div className={styles.rows}>
          {CONFIRM_CALLS.map((row) => (
            <CensusRow
              key={row.file}
              label={row.file}
              note={row.asks}
              sample={<span className={styles.loading}>confirm</span>}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
