/** Rebuildable point facts and reducer state; lazy population, no startup backfill. */
export const CLAUDE_WRITER_STATE_SCHEMA = `
CREATE TABLE claude_transcript_nodes(generation TEXT NOT NULL,uuid TEXT NOT NULL,active INTEGER NOT NULL,
 PRIMARY KEY(generation,uuid)) WITHOUT ROWID;
CREATE TABLE claude_transcript_tools(generation TEXT NOT NULL,tool_id TEXT NOT NULL,owner_uuid TEXT,
 has_result INTEGER NOT NULL,is_task INTEGER NOT NULL,PRIMARY KEY(generation,tool_id)) WITHOUT ROWID;
CREATE TABLE claude_transcript_offsets(generation TEXT NOT NULL,source_offset INTEGER NOT NULL,position INTEGER NOT NULL,
 PRIMARY KEY(generation,source_offset)) WITHOUT ROWID;
CREATE INDEX claude_transcript_offsets_position ON claude_transcript_offsets(generation,position);
CREATE TABLE claude_transcript_tasks(generation TEXT PRIMARY KEY,state TEXT NOT NULL);
CREATE TABLE claude_transcript_queues(generation TEXT NOT NULL,source_offset INTEGER NOT NULL,
 position INTEGER,record TEXT NOT NULL,PRIMARY KEY(generation,source_offset)) WITHOUT ROWID;
`;
