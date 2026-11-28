/** Derived ordering and visibility keys. Native catalog rows remain authoritative. */
export const SESSION_API_COLLECTION_SCHEMA = `
CREATE TABLE collection_cache_api(
  id TEXT PRIMARY KEY, project_id TEXT, native_key TEXT, creator TEXT,
  updated_ms REAL NOT NULL
);
UPDATE collection_checkpoint SET valid=0 WHERE id=1;
`;
