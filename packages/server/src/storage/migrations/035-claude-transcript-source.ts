/** Rebuildable Claude source facts and logical row positions. Frozen SQL. */
export const CLAUDE_TRANSCRIPT_SOURCE_SCHEMA = `
CREATE TABLE claude_transcript_generations (generation TEXT PRIMARY KEY,path TEXT NOT NULL,owner TEXT NOT NULL,lease_until INTEGER NOT NULL);
CREATE INDEX claude_transcript_generations_path ON claude_transcript_generations(path,lease_until,generation);
CREATE TABLE claude_transcript_sources (
 path TEXT PRIMARY KEY, generation TEXT NOT NULL, revision INTEGER NOT NULL,
 header TEXT NOT NULL);
CREATE UNIQUE INDEX claude_transcript_sources_generation ON claude_transcript_sources(generation);
CREATE TABLE claude_transcript_records (
 generation TEXT NOT NULL, ordinal INTEGER NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(generation, ordinal)) WITHOUT ROWID;
CREATE TABLE claude_transcript_visible (
 generation TEXT NOT NULL, position INTEGER NOT NULL, message_id TEXT,
 compact_ordinal INTEGER, group_id TEXT, delivered_ms REAL, record TEXT NOT NULL,
 PRIMARY KEY(generation, position)) WITHOUT ROWID;
CREATE INDEX claude_transcript_visible_id ON claude_transcript_visible(generation,message_id,position);
CREATE INDEX claude_transcript_visible_compact ON claude_transcript_visible(generation,compact_ordinal) WHERE compact_ordinal IS NOT NULL;
CREATE INDEX claude_transcript_visible_boundary_position ON claude_transcript_visible(generation,position) WHERE compact_ordinal IS NOT NULL;
CREATE INDEX claude_transcript_visible_group ON claude_transcript_visible(generation,group_id,position);
CREATE INDEX claude_transcript_visible_delivery ON claude_transcript_visible(generation,delivered_ms,position) WHERE delivered_ms IS NOT NULL;
CREATE TABLE claude_transcript_orphans (
 generation TEXT NOT NULL, tool_id TEXT NOT NULL,
 PRIMARY KEY(generation,tool_id)) WITHOUT ROWID;
`;
