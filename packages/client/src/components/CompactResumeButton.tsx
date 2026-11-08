import { Button } from "./ui/Button";
import styles from "./CompactResumeButton.module.css";

interface CompactResumeButtonProps {
  label: string;
  title: string;
  pending?: boolean;
  onResume: () => void | Promise<void>;
}

export function CompactResumeButton({
  label,
  title,
  pending = false,
  onResume,
}: CompactResumeButtonProps) {
  return (
    <Button
      variant="outline"
      size="small"
      className={styles.button}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void onResume();
      }}
      disabled={pending}
      title={title}
      aria-label={label}
    >
      {pending ? "…" : label}
    </Button>
  );
}
