/**
 * Process's replay buffer for late-joining clients: two buckets swapped
 * every {@link PROCESS_REPLAY_BUCKET_MS}, so a buffered message stays at
 * most {@link PROCESS_REPLAY_RETENTION_MS}. In-turn steer echoes are put
 * back into that buffer at the turn's boundary. A provider that changes a
 * row's identity waits this long after the row was buffered, so no late
 * joiner can receive the row's old identity from the buffer.
 */
export const PROCESS_REPLAY_BUCKET_MS = 15_000;
export const PROCESS_REPLAY_RETENTION_MS = 2 * PROCESS_REPLAY_BUCKET_MS;
