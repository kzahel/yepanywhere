import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useTextTooltipAttributes } from "../../hooks/useTooltipAppearance";
import { IconButton, buttonClassName } from "./Button";
import styles from "./SelectionActionCluster.module.css";

export const SELECTION_ACTION_BUTTON_SIZE_PX = 32;
export const SELECTION_ACTION_BUTTON_MOBILE_SIZE_PX = 44;
export const SELECTION_ACTION_GAP_PX = 6;

export type SelectionActionKind =
  | "text"
  | "source"
  | "rich"
  | "quote"
  | "newSession";

interface SelectionActionButtonProps {
  kind: SelectionActionKind;
  label: string;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  specimen?: boolean;
}

function CopyTextGlyph() {
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

const GLYPHS: Record<SelectionActionKind, ReactNode> = {
  text: <CopyTextGlyph />,
  quote: ">",
  source: <CopyTextGlyph />,
  rich: "Aa",
  newSession: "+",
};
const KIND_STYLES: Record<SelectionActionKind, string> = {
  text: styles.text!,
  quote: styles.quote!,
  source: styles.source!,
  rich: styles.rich!,
  newSession: styles.newSession!,
};

export function SelectionActionButton({
  kind,
  label,
  onClick,
  onPointerDown,
  onPointerUp,
  specimen = false,
}: SelectionActionButtonProps) {
  const className = specimen ? styles.specimen : undefined;
  const glyph = <span className={KIND_STYLES[kind]}>{GLYPHS[kind]}</span>;
  const tooltip = useTextTooltipAttributes(label);
  if (specimen) {
    return (
      <span
        className={buttonClassName({
          variant: "secondary",
          icon: true,
          elevated: true,
          className,
        })}
        aria-hidden="true"
        data-selection-action-specimen={kind}
      >
        {glyph}
      </span>
    );
  }

  return (
    <IconButton
      variant="secondary"
      elevated
      label={label}
      {...tooltip}
      className={className}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        event.preventDefault();
        onPointerDown?.(event);
      }}
      onPointerUp={onPointerUp}
      onClick={onClick}
      aria-label={label}
    >
      {glyph}
    </IconButton>
  );
}

interface SelectionActionClusterProps {
  children: ReactNode;
  docked?: boolean;
  mobile?: boolean;
  placement?: "above" | "after" | "before" | "below";
  style?: CSSProperties;
}

export function SelectionActionCluster({
  children,
  docked = false,
  mobile = false,
  placement,
  style,
}: SelectionActionClusterProps) {
  return (
    <div
      className={[
        styles.cluster,
        docked ? styles.docked : "",
        mobile ? styles.mobile : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      data-selection-action-cluster="true"
      data-selection-action-placement={placement}
    >
      {children}
    </div>
  );
}
