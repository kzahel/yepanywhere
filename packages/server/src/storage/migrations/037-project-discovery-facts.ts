/** Source-owned compact project observations; no session corpus mirror. Frozen SQL. */
export const PROJECT_DISCOVERY_FACTS_SCHEMA = `
CREATE TABLE project_discovery_state (
 id INTEGER PRIMARY KEY CHECK(id=1), source_key TEXT NOT NULL
);
CREATE TABLE project_discovery_facts (
 identity_key TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE,
 position INTEGER NOT NULL, payload TEXT NOT NULL
) WITHOUT ROWID;
`;
