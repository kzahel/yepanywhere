import styles from "./FilePathDisplay.module.css";
import { splitDisplayPath } from "../../lib/text";

interface FilePathDisplayProps {
  displayPath: string;
}

export function FilePathDisplay({ displayPath }: FilePathDisplayProps) {
  const { dir, name } = splitDisplayPath(displayPath);
  return (
    <span
      className={styles.filePathDisplay}
      data-file-path-display
      title={displayPath}
    >
      {dir && (
        <span className={styles.filePathDisplayDir} data-file-path-display-dir>
          {dir}
        </span>
      )}
      <span data-file-path-display-name="">{name}</span>
    </span>
  );
}
