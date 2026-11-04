/** Durable provider summaries, addressed by native store/project scope and id. */
export const SESSION_SUMMARY_INDEX_SCHEMA = `
CREATE TABLE session_summary_scopes (
  scope TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  format_version INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE session_summary_index (
  scope TEXT NOT NULL REFERENCES session_summary_scopes(scope) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  PRIMARY KEY (scope, session_id)
) WITHOUT ROWID;
`;
