import { createLocalStorageBoolean } from "./localStorageValue";
import type {
  SessionViewerControllerState,
  SessionViewerRegistration,
} from "./sessionViewerController";
import { UI_KEYS } from "./storageKeys";

export const sessionRightPaneSetting = createLocalStorageBoolean(
  UI_KEYS.sessionRightPane,
  false,
);

/**
 * Right pane viewers leave the session transcript live beside them.
 *
 * Every session-owned viewer the setting covers answers here, so a detail
 * panel published from a tool row lands in the pane on the same terms as a
 * file viewer rather than covering the transcript.
 */
export function sessionViewerUsesRightPane(viewer: {
  kind: SessionViewerRegistration["kind"];
  sessionId: string;
  supportsRightPane?: boolean;
}): boolean {
  if (viewer.kind === "vhost") return true;
  if (!viewer.sessionId || !sessionRightPaneSetting.read()) return false;
  if (viewer.kind === "panel") return true;
  return viewer.kind === "file" && !!viewer.supportsRightPane;
}

/**
 * The composer's bottom viewer controller stands in for a viewer the reader
 * cannot see or reach from its own chrome. A covering viewer earns it while
 * open, since its header may be scrolled away; a right-pane viewer keeps its
 * own header beside the transcript, so only minimizing it creates the chip.
 */
export function sessionViewerShowsBottomController(
  viewer: SessionViewerControllerState,
): boolean {
  return viewer.minimized || !sessionViewerUsesRightPane(viewer);
}
