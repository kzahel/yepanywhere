/** Permanent public identity; native addresses are scoped, never public renames. */
export const SESSION_IDENTITIES_SCHEMA = `
CREATE TABLE session_identities (
  session_id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  native_family TEXT,
  native_scope TEXT,
  native_id TEXT,
  CHECK (
    (native_family IS NULL AND native_scope IS NULL AND native_id IS NULL)
    OR
    (native_family IS NOT NULL AND native_scope IS NOT NULL AND native_id IS NOT NULL)
  )
) WITHOUT ROWID;
CREATE UNIQUE INDEX session_native_binding
  ON session_identities (native_family, native_scope, native_id);
CREATE INDEX session_identity_project ON session_identities (project_id);
`;
