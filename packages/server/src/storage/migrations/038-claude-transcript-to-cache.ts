/**
 * The Claude transcript index moved to the rebuildable cache database
 * (`storage/cache-sqlite.ts`), which rebuilds it on demand. Frozen SQL.
 */
export const CLAUDE_TRANSCRIPT_TO_CACHE_SCHEMA = `
DROP TABLE IF EXISTS claude_transcript_queues;
DROP TABLE IF EXISTS claude_transcript_tasks;
DROP TABLE IF EXISTS claude_transcript_offsets;
DROP TABLE IF EXISTS claude_transcript_tools;
DROP TABLE IF EXISTS claude_transcript_nodes;
DROP TABLE IF EXISTS claude_transcript_orphans;
DROP TABLE IF EXISTS claude_transcript_visible;
DROP TABLE IF EXISTS claude_transcript_records;
DROP TABLE IF EXISTS claude_transcript_sources;
DROP TABLE IF EXISTS claude_transcript_generations;
`;
