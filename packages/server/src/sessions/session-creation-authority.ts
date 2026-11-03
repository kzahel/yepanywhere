import type { DesktopControlOrigin } from "../desktop/machine-control.js";
import type { SavedSessionCreation } from "./SessionCreationStore.js";

/** Live proof supplied by the authenticated caller, never a saved launch flag. */
export interface CreationAuthority {
  desktopControlOrigin?: DesktopControlOrigin;
}
export type AuthorizeSessionCreation = (
  saved: SavedSessionCreation,
) => Promise<void> | Promise<CreationAuthority | undefined>;
