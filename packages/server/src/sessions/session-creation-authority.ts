import type { SavedSessionCreation } from "./SessionCreationStore.js";

/** Rechecks the live caller's authority for a saved creation; throws if lost. */
export type AuthorizeSessionCreation = (
  saved: SavedSessionCreation,
) => Promise<void>;
