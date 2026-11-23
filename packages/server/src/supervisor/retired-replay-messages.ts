/**
 * Live message IDs a provider has retired because its durable history now
 * serves those rows under other IDs (Antigravity moves a turn from its
 * owner's memory to the brain log, plan 195 step 6). Late-join replay of
 * Process's buffer skips them, so a viewer that loaded the durable rows does
 * not get the same rows again under their live IDs.
 *
 * Kept for twice as long as Process's replay buffer can hold a message (at
 * most about 30 seconds), and never more than a fixed number of IDs.
 * Pruned as IDs are added: no timer.
 */
const KEEP_MS = 60_000;
const MAX_IDS = 16_384;
const retired = new Map<string, number>();

export function retireReplayMessages(
  ids: Iterable<string>,
  now = Date.now(),
): void {
  for (const id of ids) {
    retired.delete(id);
    retired.set(id, now);
  }
  for (const [id, at] of retired) {
    if (retired.size <= MAX_IDS && now - at <= KEEP_MS) break;
    retired.delete(id);
  }
}

export function isReplayMessageRetired(id: unknown, now = Date.now()): boolean {
  if (typeof id !== "string") return false;
  const at = retired.get(id);
  return at !== undefined && now - at <= KEEP_MS;
}
