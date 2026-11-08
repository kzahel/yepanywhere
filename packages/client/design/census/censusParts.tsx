import { type ReactNode, useEffect, useState } from "react";
import { classUsage } from "virtual:ya-design-data";
import styles from "./Census.module.css";

/*
 * Loaded on demand: importing every client CSS Module injects all of them,
 * which only the module census needs. Hashed names stay scoped, so the
 * injected rules cannot restyle anything else on the page.
 */
const moduleStylesheets = import.meta.glob<{ default: Record<string, string> }>(
  "../../src/**/*.module.css",
);

export interface ModuleClass {
  file: string;
  name: string;
  className: string;
}

export function useModuleClasses(
  accept: (name: string) => boolean,
): ModuleClass[] | undefined {
  const [classes, setClasses] = useState<ModuleClass[]>();
  useEffect(() => {
    let live = true;
    void Promise.all(
      Object.entries(moduleStylesheets).map(async ([path, load]) => {
        const names = (await load()).default;
        return Object.entries(names)
          .filter(([name]) => accept(name))
          .map(([name, className]) => ({
            file: path.replace(/^\.\.\/\.\.\/src\//, ""),
            name,
            className,
          }));
      }),
    ).then((groups) => {
      if (live)
        setClasses(
          groups
            .flat()
            .sort(
              (a, b) =>
                a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
            ),
        );
    });
    return () => {
      live = false;
    };
  }, [accept]);
  return classes;
}

export function uses(className: string | undefined) {
  return className ? classUsage[className] : undefined;
}

export function UsageCount({ className }: { className: string | undefined }) {
  const usage = uses(className);
  if (!usage) return null;
  return (
    <span className={`${styles.count} ${usage.uses === 0 ? styles.zero : ""}`}>
      {usage.uses === 0
        ? "no static use"
        : `${usage.uses} use${usage.uses === 1 ? "" : "s"} in ${usage.files} file${usage.files === 1 ? "" : "s"}`}
    </span>
  );
}

export function CensusRow({
  sample,
  becomes,
  label,
  counted,
  note,
}: {
  sample: ReactNode;
  /** What the legacy sample turns into, shown after an arrow. */
  becomes?: ReactNode;
  label: string;
  counted?: string;
  note?: string;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.sample}>{sample}</div>
      {becomes ? (
        <div className={styles.becomes}>
          <span aria-hidden="true">→</span>
          {becomes}
        </div>
      ) : null}
      <div className={styles.meta}>
        <code>{label}</code>
        <UsageCount className={counted} />
        {note ? <span>{note}</span> : null}
      </div>
    </div>
  );
}
