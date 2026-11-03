/** Admit the separate Antigravity family without changing existing claims. */
export const ANTIGRAVITY_NATIVE_ALLOCATIONS_SCHEMA = `
ALTER TABLE native_session_allocations RENAME TO native_session_allocations_previous;
DROP INDEX native_session_allocation_scope;
CREATE TABLE native_session_allocations (
  creation_id TEXT PRIMARY KEY NOT NULL REFERENCES session_creations(id),
  attempt_id TEXT NOT NULL REFERENCES session_creation_attempts(id),
  generation INTEGER NOT NULL,
  native_family TEXT NOT NULL CHECK (native_family IN ('claude', 'codex', 'gemini', 'opencode', 'pi', 'grok', 'antigravity')),
  native_scope TEXT NOT NULL CHECK (length(native_scope) BETWEEN 1 AND 4096)
) WITHOUT ROWID;
INSERT INTO native_session_allocations SELECT * FROM native_session_allocations_previous;
DROP TABLE native_session_allocations_previous;
CREATE INDEX native_session_allocation_scope ON native_session_allocations (native_family, native_scope);
`;
