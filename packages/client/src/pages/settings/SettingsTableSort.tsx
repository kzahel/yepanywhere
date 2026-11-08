import { useState } from "react";
import { ButtonBase } from "../../components/ui/Button";
import styles from "./SettingsTableSort.module.css";

type TableSort<Key extends string> = {
  column: Key;
  direction: "ascending" | "descending";
};

/** Sort the displayed rows without changing their stored order or identity. */
export function useSettingsTableSort<Key extends string>() {
  const [sort, setSort] = useState<TableSort<Key> | null>(null);
  function onSort(column: Key) {
    setSort((previous) => ({
      column,
      direction:
        previous?.column === column && previous.direction === "ascending"
          ? "descending"
          : "ascending",
    }));
  }
  function sortedRows<Row>(
    rows: Row[],
    value: (row: Row, column: Key) => string | number,
  ): Row[] {
    if (!sort) return rows;
    const direction = sort.direction === "ascending" ? 1 : -1;
    return [...rows].sort((left, right) => {
      const a = value(left, sort.column);
      const b = value(right, sort.column);
      return (
        direction *
        (typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), undefined, {
              numeric: true,
              sensitivity: "base",
            }))
      );
    });
  }
  return { sort, onSort, sortedRows };
}

/** A clickable column heading with visible and accessible sort direction. */
export function SettingsSortHeader<Key extends string>({
  column,
  label,
  sort,
  onSort,
}: {
  column: Key;
  label: string;
  sort: TableSort<Key> | null;
  onSort: (column: Key) => void;
}) {
  const direction = sort?.column === column ? sort.direction : "none";
  return (
    <th className={styles.header} scope="col" aria-sort={direction}>
      <ButtonBase className={styles.button} onClick={() => onSort(column)}>
        {label}
        <span aria-hidden="true">
          {direction === "ascending"
            ? "↑"
            : direction === "descending"
              ? "↓"
              : "↕"}
        </span>
      </ButtonBase>
    </th>
  );
}
