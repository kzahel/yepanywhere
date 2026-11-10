import {
  memo,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTextTooltipAttributes } from "../../hooks/useTooltipAppearance";
import { writeClipboardText } from "../../lib/clipboard";
import {
  Button,
  IconButton,
  type ButtonSize,
  type ButtonVariant,
} from "./Button";
import styles from "./CopyTextButton.module.css";

interface Props {
  text: string;
  label: string;
  className?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  subdued?: boolean;
  copiedLabel?: string;
  showTextLabel?: boolean;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

export const CopyTextButton = memo(function CopyTextButton({
  text,
  label,
  className,
  variant = "secondary",
  size = "small",
  subdued = false,
  copiedLabel = "Copied message text",
  showTextLabel = false,
  onClick,
}: Props) {
  const [copied, setCopied] = useState(false);
  const copiedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(
    () => () => {
      if (copiedResetTimerRef.current !== null) {
        clearTimeout(copiedResetTimerRef.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      const success = await writeClipboardText(text);
      if (!success) {
        console.error(`Failed to copy text for ${label}`);
        return;
      }

      if (copiedResetTimerRef.current !== null) {
        clearTimeout(copiedResetTimerRef.current);
      }
      setCopied(true);
      copiedResetTimerRef.current = setTimeout(() => {
        copiedResetTimerRef.current = null;
        setCopied(false);
      }, 1800);
    },
    [label, onClick, text],
  );

  const tooltip = useTextTooltipAttributes(copied ? copiedLabel : label);
  const icon = copied ? <CheckIcon /> : <CopyIcon />;
  if (!showTextLabel) {
    return (
      <IconButton
        label={copied ? copiedLabel : label}
        variant={copied ? "success-outline" : variant}
        size={size}
        subdued={subdued}
        className={className}
        onClick={handleCopy}
      >
        {icon}
      </IconButton>
    );
  }
  return (
    <Button
      {...tooltip}
      variant={copied ? "success-outline" : variant}
      size={size}
      subdued={subdued}
      className={className}
      onClick={handleCopy}
      aria-label={copied ? copiedLabel : label}
    >
      {icon}
      <span className={styles.label}>{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
});

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.5 4.5 6.5 11.5 2.5 7.5" />
    </svg>
  );
}
