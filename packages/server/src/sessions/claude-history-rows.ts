/** Already acquired compact evidence, addressed by original parsed row ordinal. */
export interface ClaudeHistorySource {
  readonly length: number;
  get(ordinal: number): unknown;
  isCurrent(): boolean;
}
export type ClaudeHistoryRows = readonly unknown[] | ClaudeHistorySource;
export function claudeHistoryRow(
  rows: ClaudeHistoryRows,
  ordinal: number,
): unknown {
  return "get" in rows ? rows.get(ordinal) : rows[ordinal];
}
export function currentClaudeHistoryRows(rows: ClaudeHistoryRows): boolean {
  return !("isCurrent" in rows) || rows.isCurrent();
}
