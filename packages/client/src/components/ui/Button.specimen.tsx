import type { CSSProperties } from "react";
import type { SpecimenMeta } from "../../../design/specimen";
import {
  BUTTON_VARIANTS,
  Button,
  ButtonBase,
  buttonClassName,
  IconButton,
} from "./Button";

export default {
  title: "Controls/Button",
  component: Button,
  parameters: {
    layer: "control",
    description:
      "Button, IconButton and ButtonBase from components/ui/Button.tsx. Variant and size are props; a caller's className adds layout only.",
  },
} satisfies SpecimenMeta;

const column: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "var(--space-2)",
};
const row: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2)",
};
const caption: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: "var(--font-size-xs)",
  fontFamily: "var(--font-mono)",
};

const PLUS = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
const TRASH = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
  </svg>
);

function sampleText(variant: string) {
  return variant.startsWith("danger") ? "Delete" : "Save changes";
}

export function Variants() {
  return (
    <div style={column}>
      {BUTTON_VARIANTS.map((variant) => (
        <div key={variant} style={row}>
          <span style={{ ...caption, width: "8rem" }}>{variant}</span>
          <Button variant={variant}>{sampleText(variant)}</Button>
          <Button variant={variant} disabled>
            Disabled
          </Button>
          <Button variant={variant} busy>
            Saving
          </Button>
          <IconButton variant={variant} label="Add">
            {variant.startsWith("danger") ? TRASH : PLUS}
          </IconButton>
        </div>
      ))}
    </div>
  );
}

export function Small() {
  return (
    <div style={column}>
      {BUTTON_VARIANTS.map((variant) => (
        <div key={variant} style={row}>
          <span style={{ ...caption, width: "8rem" }}>{variant}</span>
          <Button variant={variant} size="small">
            {sampleText(variant)}
          </Button>
          <Button variant={variant} size="small" disabled>
            Disabled
          </Button>
          <Button variant={variant} size="small" busy>
            Saving
          </Button>
          <IconButton variant={variant} size="small" label="Add">
            {variant.startsWith("danger") ? TRASH : PLUS}
          </IconButton>
        </div>
      ))}
    </div>
  );
}

export function WithIcon() {
  return (
    <div style={row}>
      <Button variant="primary">
        {PLUS}
        New session
      </Button>
      <Button>
        {PLUS}
        Add server
      </Button>
      <Button variant="danger-outline" size="small">
        {TRASH}
        Remove
      </Button>
    </div>
  );
}
WithIcon.storyName = "With a leading icon";

export function IconPressed() {
  return (
    <div style={row}>
      <IconButton label="Pin" aria-pressed={false}>
        {PLUS}
      </IconButton>
      <IconButton label="Unpin" aria-pressed>
        {PLUS}
      </IconButton>
    </div>
  );
}
IconPressed.storyName = "Icon button, toggled";

export function LinkLooksLikeButton() {
  return (
    <div style={row}>
      <a className={buttonClassName()} href="#/">
        Open docs
      </a>
      <a className={buttonClassName({ variant: "primary" })} href="#/">
        Sign in
      </a>
    </div>
  );
}
LinkLooksLikeButton.storyName = "Link styled with buttonClassName";

export function Base() {
  return (
    <div style={column}>
      <ButtonBase
        style={{
          padding: "var(--space-2) var(--space-3)",
          borderRadius: "var(--radius-md)",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-color)",
          width: "18rem",
        }}
      >
        A clickable card: ButtonBase plus its owner's styles
      </ButtonBase>
      <ButtonBase style={{ color: "var(--link-color)" }}>
        An unstyled disclosure
      </ButtonBase>
    </div>
  );
}
Base.storyName = "ButtonBase (owner styles)";
