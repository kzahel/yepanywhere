/** Canonical catalog counts and indexed point/store observations. Frozen SQL. */
export const CATALOG_QUERY_OWNERSHIP_SCHEMA = `
ALTER TABLE catalog_state ADD COLUMN row_count INTEGER NOT NULL DEFAULT 0;
UPDATE catalog_state SET row_count=(SELECT count(*) FROM session_catalog WHERE deleted=0);
ALTER TABLE session_catalog ADD COLUMN direct_file INTEGER NOT NULL DEFAULT 0;
UPDATE session_catalog SET direct_file=1 WHERE location_kind='file'
 AND substr(location_path,1,length(store_key)+1) IN (store_key||'/',store_key||char(92))
 AND instr(substr(location_path,length(store_key)+2),'/')=0
 AND instr(substr(location_path,length(store_key)+2),char(92))=0;
CREATE INDEX session_catalog_path ON session_catalog(location_path) WHERE deleted=0 AND location_kind='file';
CREATE INDEX session_catalog_native_id ON session_catalog(native_id) WHERE deleted=0;
CREATE INDEX session_catalog_store_project ON session_catalog(family,store_key,direct_file,project_key,id) WHERE deleted=0;
CREATE INDEX session_catalog_bad_questions ON session_catalog(id)
 WHERE async_questions IS NOT NULL AND NOT json_valid(async_questions);
CREATE TABLE catalog_store_projects (
 family TEXT NOT NULL,store_key TEXT NOT NULL,project_key TEXT NOT NULL,
 members INTEGER NOT NULL,PRIMARY KEY(family,store_key,project_key)
) WITHOUT ROWID;
INSERT INTO catalog_store_projects SELECT family,store_key,project_key,count(*)
 FROM session_catalog WHERE deleted=0 AND direct_file=1 GROUP BY family,store_key,project_key;
CREATE TRIGGER catalog_row_insert AFTER INSERT ON session_catalog BEGIN
 UPDATE catalog_state SET row_count=row_count+(1-NEW.deleted) WHERE id=1;
 INSERT INTO catalog_store_projects SELECT NEW.family,NEW.store_key,NEW.project_key,1
 WHERE NEW.deleted=0 AND NEW.direct_file=1
 ON CONFLICT(family,store_key,project_key) DO UPDATE SET members=members+1;
END;
CREATE TRIGGER catalog_row_update AFTER UPDATE ON session_catalog BEGIN
 UPDATE catalog_state SET row_count=row_count+OLD.deleted-NEW.deleted WHERE id=1;
 UPDATE catalog_store_projects SET members=members-1 WHERE OLD.deleted=0 AND OLD.direct_file=1
 AND family=OLD.family AND store_key=OLD.store_key AND project_key=OLD.project_key;
 DELETE FROM catalog_store_projects WHERE members=0 AND family=OLD.family AND store_key=OLD.store_key AND project_key=OLD.project_key;
 INSERT INTO catalog_store_projects SELECT NEW.family,NEW.store_key,NEW.project_key,1
 WHERE NEW.deleted=0 AND NEW.direct_file=1
 ON CONFLICT(family,store_key,project_key) DO UPDATE SET members=members+1;
END;
CREATE TRIGGER catalog_row_delete AFTER DELETE ON session_catalog BEGIN
 UPDATE catalog_state SET row_count=row_count-(1-OLD.deleted) WHERE id=1;
 UPDATE catalog_store_projects SET members=members-1 WHERE OLD.deleted=0 AND OLD.direct_file=1
 AND family=OLD.family AND store_key=OLD.store_key AND project_key=OLD.project_key;
 DELETE FROM catalog_store_projects WHERE members=0 AND family=OLD.family AND store_key=OLD.store_key AND project_key=OLD.project_key;
END;
`;
