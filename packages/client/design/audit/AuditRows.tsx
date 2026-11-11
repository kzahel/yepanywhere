import type { CensusEntry } from "../openCensus";
import styles from "./Audit.module.css";

export function AuditRows({ rows }: { rows: CensusEntry[] }) {
  return (
    <ul className={styles.rows}>
      {rows.map((row) => (
        <li
          key={`${row.element}:${row.where}`}
          className={styles.row}
          data-audit-row=""
        >
          <code>{row.element}</code>
          <dl className={styles.details}>
            <dt>Where</dt>
            <dd>
              <code>{row.where}</code>
            </dd>
            <dt>Reason</dt>
            <dd>{row.reason}</dd>
            <dt>Resolution</dt>
            <dd>{row.close}</dd>
          </dl>
        </li>
      ))}
    </ul>
  );
}

export function AllowanceGroup({
  title,
  element,
  entries,
  close,
}: {
  title: string;
  element: string;
  entries: Record<string, { count: number; reason: string }>;
  close: string;
}) {
  const total = Object.values(entries).reduce(
    (sum, entry) => sum + entry.count,
    0,
  );
  if (!total) return null;
  return (
    <section className={styles.group}>
      <h3 className={styles.groupTitle}>
        {title} · {total} exceptions in {Object.keys(entries).length} files
      </h3>
      <AuditRows
        rows={Object.entries(entries).map(([file, entry]) => ({
          element,
          where: `${file} · ${entry.count} / ${total} exceptions`,
          reason: entry.reason,
          close: /composer/i.test(entry.reason)
            ? "Complete plan 182's composer pass and lower this file's allowlist count to zero."
            : close,
        }))}
      />
    </section>
  );
}
