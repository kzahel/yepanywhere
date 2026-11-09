/**
 * The session catalog as rows (plan 189 step 3). One row per adapter row key;
 * a removed row stays as a tombstone so change readers see it. The full title
 * lives beside the row, so list columns never sit behind a long text value.
 * The table is a rebuildable cache, so a new fidelity or location kind may
 * rebuild it to widen its CHECK constraints. Sort indexes for list pages
 * belong to step 7, which knows its queries.
 */
export const SESSION_CATALOG_SCHEMA = `
CREATE TABLE catalog_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch TEXT NOT NULL CHECK (length(epoch) > 0),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  tombstone_horizon INTEGER NOT NULL CHECK (tombstone_horizon >= 0),
  completed_at TEXT NOT NULL
);
CREATE TABLE catalog_sources (
  family TEXT NOT NULL,
  store_key TEXT NOT NULL,
  PRIMARY KEY (family, store_key)
) WITHOUT ROWID;
CREATE TABLE session_catalog (
  id INTEGER PRIMARY KEY,
  family TEXT NOT NULL,
  store_key TEXT NOT NULL,
  native_id TEXT NOT NULL,
  native_storage_scope TEXT,
  native_directory_project_id TEXT,
  project_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  project_name TEXT,
  provider TEXT,
  title TEXT,
  title_null INTEGER NOT NULL DEFAULT 0 CHECK (title_null IN (0, 1)),
  created_at TEXT,
  updated_at TEXT NOT NULL,
  last_human_turn_at TEXT,
  async_questions TEXT,
  fidelity TEXT NOT NULL CHECK (fidelity IN ('identity', 'head', 'tail')),
  row_format INTEGER,
  source_version TEXT NOT NULL,
  location_kind TEXT NOT NULL
    CHECK (location_kind IN ('file', 'database', 'provider')),
  location_path TEXT,
  location_record_id TEXT,
  row_hash TEXT NOT NULL,
  changed_gen INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
);
CREATE UNIQUE INDEX session_catalog_key
  ON session_catalog (family, store_key, native_id);
CREATE INDEX session_catalog_native
  ON session_catalog (family, native_storage_scope, native_id);
CREATE INDEX session_catalog_project ON session_catalog (project_key);
CREATE INDEX session_catalog_changed ON session_catalog (changed_gen);
CREATE TABLE session_catalog_text (
  catalog_id INTEGER PRIMARY KEY
    REFERENCES session_catalog (id) ON DELETE CASCADE,
  full_title TEXT NOT NULL
);
`;
