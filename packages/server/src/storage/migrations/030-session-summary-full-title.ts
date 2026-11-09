/**
 * Summary rows keep the full title in its own column (plan 189 step 5, gap
 * item 22). `fullTitle` was 8.6 MB of the 13.2 MB of summary JSON here, and
 * one blob per key in a `WITHOUT ROWID` table overflowed into half-empty
 * pages. The rebuilt table is a rowid table: `summary` holds the JSON without
 * `fullTitle`, and `full_title` comes last, so later small columns never sit
 * behind a long title. NULL stands for a null `fullTitle`.
 *
 * A summary whose JSON escapes a lone surrogate or a NUL keeps its title in
 * the JSON: extracting it to text would replace the surrogate, and
 * node:sqlite cuts text at a NUL. `JSON.stringify` escapes only lone
 * surrogates and control characters, so the GLOBs find every such row; a
 * false match (another field, or a literal backslash) only leaves that title
 * in place until the next save moves it. Rows that are not valid JSON
 * objects, or whose scope is gone, are not carried over: summaries are a
 * cache rebuilt from provider transcripts.
 */
export const SESSION_SUMMARY_FULL_TITLE_SCHEMA = `
CREATE TABLE session_summary_index_next (
 id INTEGER PRIMARY KEY,
 scope TEXT NOT NULL REFERENCES session_summary_scopes(scope) ON DELETE CASCADE,
 session_id TEXT NOT NULL,
 summary TEXT NOT NULL,
 full_title TEXT,
 UNIQUE (scope, session_id)
);
INSERT INTO session_summary_index_next (scope, session_id, summary, full_title)
SELECT scope, session_id,
 CASE WHEN kept THEN summary ELSE json_remove(summary, '$.fullTitle') END,
 CASE WHEN NOT kept AND json_type(summary, '$.fullTitle') = 'text'
 THEN json_extract(summary, '$.fullTitle') END
FROM (
 SELECT scope, session_id, summary,
  json_type(summary, '$.fullTitle') = 'text'
  AND (summary GLOB '*\\[uU][dD][89a-fA-F]*' OR summary GLOB '*\\u0000*') AS kept
 FROM session_summary_index
 WHERE CASE WHEN json_valid(summary) THEN json_type(summary) END = 'object'
  AND scope IN (SELECT scope FROM session_summary_scopes)
)
ORDER BY scope, session_id;
DROP TABLE session_summary_index;
ALTER TABLE session_summary_index_next RENAME TO session_summary_index;
`;
