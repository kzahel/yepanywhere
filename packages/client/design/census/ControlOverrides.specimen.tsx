import type { SpecimenMeta } from "../specimen";
import allowlist from "./control-override-allowlist.json";
import styles from "./Census.module.css";

export default {
  title: "Census/Control overrides",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Every remaining caller-class exception to shared control ownership. Counts and reasons come directly from the lint allowlist; controls:check --record only lowers them.",
  },
} satisfies SpecimenMeta;

export function Remaining() {
  return (
    <div className={styles.census}>
      {(["buttons", "controls"] as const).map((family) => {
        const entries = Object.entries(allowlist[family]);
        const total = entries.reduce((sum, [, entry]) => sum + entry.count, 0);
        return (
          <section key={family} className={styles.group}>
            <h3 className={styles.groupTitle}>
              {family === "buttons" ? "Button family" : "Other shared controls"}
              : {total} sites in {entries.length} files
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
      })}
    </div>
  );
}
Remaining.storyName = "Remaining counted exceptions";
