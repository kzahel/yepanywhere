import type { SpecimenMeta } from "../specimen";
import allowlist from "./button-base-allowlist.json";
import styles from "./Census.module.css";

export default {
  title: "Census/ButtonBase exceptions",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Rich rows, previews and specialized targets with painted borders/rings, filled rounded chips or link/underline text. buttons:check resolves classes, states and ancestors; every exception has a count and reason, and --record only lowers it.",
  },
} satisfies SpecimenMeta;

export function Remaining() {
  const entries = Object.entries(allowlist);
  const total = entries.reduce((sum, [, entry]) => sum + entry.count, 0);
  return (
    <section className={styles.census}>
      <h3 className={styles.groupTitle}>
        {total} sites in {entries.length} files
      </h3>
      <ul className={styles.elements}>
        {entries.map(([file, entry]) => (
          <li key={file}>
            <code>{file}</code> · {entry.count}
            <p>{entry.reason}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
Remaining.storyName = "Remaining counted exceptions";
