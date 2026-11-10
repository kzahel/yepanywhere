import styles from "./BottomOverscrollReload.module.css";
import {
  type BottomOverscrollReloadStatus,
  useBottomOverscrollReload,
} from "../hooks/useBottomOverscrollReload";

interface BottomOverscrollReloadProps {
  disabled?: boolean;
  onReload: () => void;
}

function getLabel(status: BottomOverscrollReloadStatus): string {
  return status === "armed" ? "Release to reload" : "Pull up to reload";
}

export function BottomOverscrollReload({
  disabled = false,
  onReload,
}: BottomOverscrollReloadProps) {
  const status = useBottomOverscrollReload(onReload, { disabled });

  if (status === "hidden") {
    return null;
  }

  return (
    <div
      className={`${styles["bottom-overscroll-reload"]} ${status === "armed" ? styles["bottom-overscroll-reload--armed"] : styles["bottom-overscroll-reload--pull"]}`}
      data-bottom-overscroll-reload
      aria-live="polite"
    >
      {getLabel(status)}
    </div>
  );
}
