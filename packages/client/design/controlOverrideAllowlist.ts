import { BUTTON_CONTROLS, type ControlOverride } from "./controlOverrides";

export interface OverrideAllowance {
  count: number;
  reason: string;
}
export interface ControlOverrideAllowlist {
  buttons: Record<string, OverrideAllowance>;
  controls: Record<string, OverrideAllowance>;
}

/** Count callsites, not declarations: a state selector cannot hide behind a base rule. */
export function checkControlAllowlist(
  rows: ControlOverride[],
  allowlist: ControlOverrideAllowlist,
  record = false,
) {
  const problems: string[] = [];
  const next: ControlOverrideAllowlist = { buttons: {}, controls: {} };
  for (const section of ["buttons", "controls"] as const) {
    const counts = new Map<string, number>();
    for (const row of rows)
      if (BUTTON_CONTROLS.has(row.control) === (section === "buttons"))
        counts.set(row.file, (counts.get(row.file) ?? 0) + 1);
    const entries = allowlist[section];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      problems.push(`Missing ${section} allowlist`);
      continue;
    }
    for (const [file, entry] of Object.entries(entries)) {
      if (
        !Number.isInteger(entry.count) ||
        entry.count < 1 ||
        typeof entry.reason !== "string" ||
        !entry.reason.trim()
      ) {
        problems.push(
          `${section}/${file}: an exception needs a positive count and a specific reason`,
        );
        counts.delete(file);
        continue;
      }
      const actual = counts.get(file) ?? 0;
      if (actual > entry.count)
        problems.push(
          `${section}/${file}: ${actual} overrides exceed ${entry.count} (${entry.reason})`,
        );
      if (actual < entry.count && !record)
        problems.push(
          `${section}/${file}: ${actual} overrides remain, recorded ${entry.count}; run controls:check --record`,
        );
      if (actual)
        next[section][file] = {
          count: Math.min(actual, entry.count),
          reason: entry.reason,
        };
      counts.delete(file);
    }
    for (const [file, count] of counts)
      problems.push(
        `${section}/${file}: ${count} caller override(s) without a reviewed exception`,
      );
  }
  return { problems, next };
}
