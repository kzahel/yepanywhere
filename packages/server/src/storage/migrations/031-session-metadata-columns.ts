/**
 * Session metadata keeps its queried fields in columns (plan 189 step 6, gap
 * items 3 and 23). The rebuilt table is a rowid table keyed by a unique
 * `session_id`; `extra` holds the rest of the object as JSON, and
 * `initial_prompt` (2.5 of 4.2 MB here) comes last so later small columns do
 * not sit behind it.
 *
 * A key moves to its column only when its value has the column's type: a
 * string for text columns, `true` or `false` for the 0/1 boolean columns.
 * Anything else stays in `extra` as it was, and so does a string whose JSON
 * escapes a lone surrogate or a NUL: extracting it would replace the
 * surrogate, and node:sqlite cuts text at a NUL. `JSON.stringify` escapes
 * only lone surrogates and control characters, so the per-value GLOBs find
 * every such string; a false match (a literal backslash) only leaves that
 * value in `extra` until the next save moves it. `json_remove` with a NULL
 * path returns NULL, so a kept key passes `$[0]`, which never matches an
 * object member. A row that is not a JSON object is carried over unchanged
 * in `extra`: metadata is user data, and the loader fails on it as before.
 *
 * `working_project_id` is indexed for plan 189 step 7, whose project pages
 * select a project's sessions by their working project.
 *
 * The key list is frozen here; the runtime codec is
 * `metadata/session-metadata-rows.ts`.
 */
const COLUMNS = [
  ["provider", "provider", "text"],
  ["workingProjectId", "working_project_id", "text"],
  ["isArchived", "is_archived", "boolean"],
  ["isStarred", "is_starred", "boolean"],
  ["customTitle", "custom_title", "text"],
  ["sidebarCategory", "sidebar_category", "text"],
  ["parentSessionId", "parent_session_id", "text"],
  ["parentSessionKind", "parent_session_kind", "text"],
  ["forkedFromSessionId", "forked_from_session_id", "text"],
  ["executor", "executor", "text"],
  ["sandboxLevel", "sandbox_level", "text"],
  ["initialPrompt", "initial_prompt", "text"],
] as const;

const moves = ([key, , kind]: (typeof COLUMNS)[number]) => {
  const value = `(metadata -> '$.${key}')`;
  return kind === "boolean"
    ? `CASE WHEN NOT is_object THEN 0
   WHEN json_type(metadata, '$.${key}') IN ('true', 'false') THEN 1 ELSE 0 END`
    : `CASE WHEN NOT is_object THEN 0
   WHEN json_type(metadata, '$.${key}') = 'text'
   THEN NOT (${value} GLOB '*\\[uU][dD][89a-fA-F]*' OR ${value} GLOB '*\\u0000*')
   ELSE 0 END`;
};

export const SESSION_METADATA_COLUMNS_SCHEMA = `
CREATE TABLE session_metadata_next (
 id INTEGER PRIMARY KEY,
 session_id TEXT NOT NULL UNIQUE,
${COLUMNS.filter(([, column]) => column !== "initial_prompt")
  .map(
    ([, column, kind]) =>
      ` ${column} ${kind === "boolean" ? "INTEGER" : "TEXT"},`,
  )
  .join("\n")}
 extra TEXT NOT NULL,
 initial_prompt TEXT
);
INSERT INTO session_metadata_next (session_id, ${COLUMNS.map(([, column]) => column).join(", ")}, extra)
SELECT session_id,
${COLUMNS.map(([key, column]) => ` CASE WHEN move_${column} THEN json_extract(metadata, '$.${key}') END,`).join("\n")}
 CASE WHEN is_object THEN json_remove(metadata,
${COLUMNS.map(([key, column]) => `  CASE WHEN move_${column} THEN '$.${key}' ELSE '$[0]' END`).join(",\n")})
 ELSE metadata END
FROM (
 SELECT session_id, metadata, is_object,
${COLUMNS.map((entry) => `  ${moves(entry)} AS move_${entry[1]}`).join(",\n")}
 FROM (
  SELECT session_id, metadata,
   coalesce(CASE WHEN json_valid(metadata) THEN json_type(metadata) END = 'object', 0) AS is_object
  FROM session_metadata
 )
)
ORDER BY session_id;
DROP TABLE session_metadata;
ALTER TABLE session_metadata_next RENAME TO session_metadata;
CREATE INDEX session_metadata_working_project ON session_metadata (working_project_id)
 WHERE working_project_id IS NOT NULL;
CREATE INDEX session_metadata_provider ON session_metadata (provider)
 WHERE provider IS NOT NULL;
CREATE INDEX session_metadata_sandbox ON session_metadata (sandbox_level)
 WHERE sandbox_level = 'project-write';
`;
