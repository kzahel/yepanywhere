/**
 * Issue jobs point at their catalog row instead of copying it (plan 189
 * step 4, gap item 24). `catalog_key` is the row's `sessionCatalogRowKey`,
 * the JSON array of family, store and native id; a viewed window, which has
 * no catalog row, keeps NULL. The key comes from the copied row: its native
 * id when it recorded one, else the native id the session's identity binds,
 * else the job's own id, which then is the native one. The worker joins the
 * row for everything else it read from the copy. `source_json` (6 MB here,
 * mostly titles) goes with the rebuilt table.
 */
export const ISSUE_JOB_CATALOG_KEY_SCHEMA = `
CREATE TABLE issue_index_jobs_next (
 session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_version TEXT NOT NULL,
 cursor TEXT, state TEXT NOT NULL, error TEXT, updated_at INTEGER NOT NULL,
 catalog_key TEXT, priority INTEGER NOT NULL DEFAULT 0
);
INSERT INTO issue_index_jobs_next
SELECT j.session_id, j.project_id, j.source_version, j.cursor, j.state, j.error,
 j.updated_at,
 CASE WHEN json_valid(j.source_json)
   AND json_type(j.source_json, '$.catalogFamily') = 'text'
   AND json_type(j.source_json, '$.storeKey') = 'text'
 THEN json_array(
   json_extract(j.source_json, '$.catalogFamily'),
   json_extract(j.source_json, '$.storeKey'),
   COALESCE(
     json_extract(j.source_json, '$.nativeSessionId'),
     (SELECT i.native_id FROM session_identities i WHERE i.session_id = j.session_id),
     j.session_id))
 END,
 j.priority
FROM issue_index_jobs j;
DROP TABLE issue_index_jobs;
ALTER TABLE issue_index_jobs_next RENAME TO issue_index_jobs;
CREATE INDEX issue_job_state ON issue_index_jobs(state, priority, updated_at);
CREATE INDEX issue_job_catalog_key ON issue_index_jobs(catalog_key);
`;
