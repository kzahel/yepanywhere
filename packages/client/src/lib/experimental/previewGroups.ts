import type { PreviewSession, PreviewSource } from "./previewController";

export type PreviewGrouping = "none" | "machine" | "project" | "issue";
export interface PreviewGroup {
  id: string;
  label: string | null;
  sourceName: string | null;
  rows: Array<{ source: PreviewSource; session: PreviewSession }>;
}

/** Grouping is local metadata work; it never opens a session or connection. */
export function previewGroups(
  sources: PreviewSource[],
  by: PreviewGrouping,
): PreviewGroup[] {
  if (by === "none") {
    const rows = sources
      .filter((source) => source.status !== "excluded")
      .flatMap((source) =>
        source.sessions.map((session) => ({ source, session })),
      );
    const activity = (row: (typeof rows)[number]) => {
      const timestamp = Date.parse(row.session.updatedAt);
      return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
    };
    // Stable ties preserve source/catalog order; unknown dates go last.
    rows.sort((a, b) => activity(b) - activity(a) || 0);
    return rows.length
      ? [{ id: "none", label: null, sourceName: null, rows }]
      : [];
  }
  const groups = new Map<string, PreviewGroup>();
  for (const source of sources) {
    if (source.status === "excluded") continue;
    for (const session of source.sessions) {
      const keys =
        by === "issue" && session.issues.length > 0
          ? session.issues.map((issue) => ({
              id: JSON.stringify(["issue", issue.id]),
              label: issue.key,
              sourceName: null,
            }))
          : [
              {
                id: JSON.stringify([
                  by,
                  source.host.id,
                  by === "project" ? session.projectId : null,
                ]),
                label:
                  by === "machine"
                    ? source.host.displayName
                    : by === "project"
                      ? session.projectName
                      : null,
                sourceName: by === "machine" ? null : source.host.displayName,
              },
            ];
      for (const key of keys) {
        const group = groups.get(key.id) ?? { ...key, rows: [] };
        group.rows.push({ source, session });
        groups.set(key.id, group);
      }
    }
  }
  return [...groups.values()];
}
