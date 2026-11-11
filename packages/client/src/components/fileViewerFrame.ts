import styles from "./FileViewer.module.css";

/** The frame owns page/fullscreen geometry independently of source rendering. */
export function fileViewerFrameClassName(
  standalone: boolean,
  fullscreen: boolean,
) {
  return [
    styles.fileViewer,
    styles.viewer,
    standalone && styles.fileViewerStandalone,
    fullscreen && styles.fileViewerFullscreen,
  ]
    .filter(Boolean)
    .join(" ");
}
