/** Rebuildable query checkpoint, never canonical session authority. Frozen SQL. */
export const SESSION_QUERY_CHECKPOINT_SCHEMA = `
CREATE TABLE collection_checkpoint (id INTEGER PRIMARY KEY CHECK(id=1),
 revision INTEGER NOT NULL DEFAULT 0, owner TEXT, valid INTEGER NOT NULL DEFAULT 0,
 snapshot TEXT);
INSERT INTO collection_checkpoint(id) VALUES(1);
CREATE TABLE collection_cache_rows (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, updated_ms REAL NOT NULL,
 archived INTEGER NOT NULL, automatic INTEGER NOT NULL, starred INTEGER NOT NULL,
 categorized INTEGER NOT NULL, unread INTEGER NOT NULL, attention INTEGER NOT NULL,
 active INTEGER NOT NULL, live INTEGER NOT NULL, provider TEXT NOT NULL,
 executor TEXT NOT NULL, ordinal INTEGER NOT NULL, native_key TEXT,
 parent_json TEXT, name_json TEXT NOT NULL, option_visible INTEGER NOT NULL, search_json TEXT NOT NULL, item TEXT NOT NULL);
CREATE TABLE collection_cache_sources (key TEXT PRIMARY KEY,public_id TEXT,
 project_id TEXT,project_path TEXT,ordinal INTEGER NOT NULL,unstable INTEGER NOT NULL);
CREATE TABLE collection_cache_projects(project_id TEXT PRIMARY KEY,project_path TEXT NOT NULL);
CREATE TRIGGER collection_revision_session_metadata_insert AFTER INSERT ON session_metadata BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_metadata_update AFTER UPDATE ON session_metadata BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_metadata_delete AFTER DELETE ON session_metadata BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_last_seen_insert AFTER INSERT ON session_last_seen BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_last_seen_update AFTER UPDATE ON session_last_seen BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_last_seen_delete AFTER DELETE ON session_last_seen BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_identities_insert AFTER INSERT ON session_identities BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_identities_update AFTER UPDATE ON session_identities BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_identities_delete AFTER DELETE ON session_identities BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_creations_insert AFTER INSERT ON session_creations BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_creations_update AFTER UPDATE ON session_creations BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_creations_delete AFTER DELETE ON session_creations BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_creation_attempts_insert AFTER INSERT ON session_creation_attempts BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_creation_attempts_update AFTER UPDATE ON session_creation_attempts BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER collection_revision_session_creation_attempts_delete AFTER DELETE ON session_creation_attempts BEGIN
 UPDATE collection_checkpoint SET revision=revision+1 WHERE id=1;
END;
`;
