/**
 * Legacy → canonical mapping for the button and switch census.
 *
 * Status: PROPOSED (2026-11-08). The maintainer reviews these pages and
 * confirms or edits each row; the migration steps of plan 182 then follow
 * this table, not the other way round. A class the census finds that no row
 * names appears under "unmapped" until someone assigns it.
 *
 * `classes` is the exact class list a legacy element carries, so compound
 * variants (`settings-button settings-button-danger`) render as they do in
 * the app. `counted` names the class whose use count represents the row.
 */
import type { ButtonVariant } from "../../src/components/ui/Button";

/**
 * Where a legacy control goes: a canonical variant, or a disposition for
 * controls that belong to a separate family.
 * - `composer`: the composer's own control row (send, toolbar, submit). It
 *   shares one size token and is unified as a pattern, not as a plain button.
 */
export type ButtonDisposition = ButtonVariant | "composer";

export interface LegacyButton {
  classes: string;
  counted: string;
  to: ButtonDisposition;
  small?: boolean;
  icon?: boolean;
  note?: string;
}

export const LEGACY_BUTTONS: readonly LegacyButton[] = [
  {
    classes: "btn-primary",
    counted: "btn-primary",
    to: "primary",
    note: "Brand green; the onboarding and host-offline call to action.",
  },
  {
    classes: "login-button",
    counted: "login-button",
    to: "primary",
    note: "Same green, larger padding and base font size.",
  },
  {
    classes: "settings-button",
    counted: "settings-button",
    to: "secondary",
    note: "The most used button in the app; the secondary geometry comes from it.",
  },
  {
    classes: "btn-secondary",
    counted: "btn-secondary",
    to: "secondary",
    note: "No border and a larger radius than settings-button.",
  },
  {
    classes: "copy-button",
    counted: "copy-button",
    to: "secondary",
    small: true,
  },
  {
    classes: "session-share-icon-button",
    counted: "session-share-icon-button",
    to: "secondary",
    small: true,
    note: "Named an icon button but carries text.",
  },
  {
    classes: "settings-button settings-button-secondary",
    counted: "settings-button-secondary",
    to: "outline",
    note: "Transparent with a border; 'secondary' in name only.",
  },
  {
    classes: "expand-button",
    counted: "expand-button",
    to: "outline",
    note: "Muted text and a 44 px touch height of its own.",
  },
  {
    classes: "diff-toolbar-icon-button",
    counted: "diff-toolbar-icon-button",
    to: "ghost",
    small: true,
    icon: true,
  },
  {
    classes: "settings-button settings-button-danger",
    counted: "settings-button-danger",
    to: "danger",
  },
  {
    classes: "settings-button settings-button-danger-subtle",
    counted: "settings-button-danger-subtle",
    to: "danger-outline",
  },
  {
    classes: "send-button",
    counted: "send-button",
    to: "composer",
    icon: true,
  },
  {
    classes: "toolbar-button",
    counted: "toolbar-button",
    to: "composer",
    icon: true,
  },
  {
    classes: "new-session-submit-button",
    counted: "new-session-submit-button",
    to: "composer",
  },
];

/** Global classes that are button parts or containers, not buttons. */
export function isButtonClass(name: string): boolean {
  return (
    /(?:^|[-_])(?:button|btn)(?:$|[-_])|(?:button|btn)$/i.test(name) &&
    !/(?:-|__)(?:label|icon|text|group|row|wrap|wrapper|container|list|actions|bar|buttons|area|slot|main|detail|badge)$/i.test(
      name,
    )
  );
}

export type SwitchDisposition = "switch" | "segmented" | "keep";

export interface LegacySwitch {
  name: string;
  /** Class whose use count represents the row, when it is a global class. */
  counted?: string;
  to: SwitchDisposition;
  note?: string;
}

export const LEGACY_SWITCHES: readonly LegacySwitch[] = [
  {
    name: "toggle-switch + toggle-slider",
    counted: "toggle-switch",
    to: "switch",
    note: "Pasted markup: a hidden checkbox and a styled span. Same geometry; becomes role=switch.",
  },
  {
    name: "patient-queue-switch",
    counted: "patient-queue-switch",
    to: "segmented",
    note: "A two-option track (regular / patient), not an on/off switch. The census shows its current use count.",
  },
  {
    name: "font-size-selector + font-size-option",
    counted: "font-size-option",
    to: "segmented",
    note: "The de facto segmented control; the proposal keeps its look.",
  },
  {
    name: "model-settings-chip-group",
    counted: "model-settings-chip-group",
    to: "segmented",
    note: "Wraps font-size-option buttons in model and recap settings.",
  },
  {
    name: "model-switch-chip-group + model-switch-chip",
    counted: "model-switch-chip",
    to: "segmented",
  },
  {
    name: "AttachmentQualityToggle",
    to: "segmented",
    note: "Component with its own module styles.",
  },
  {
    name: "FullPaneComposerToggle",
    to: "keep",
    note: "An expand/collapse icon action, so it becomes an IconButton with aria-pressed, not a switch.",
  },
];

/** Global classes worth a census row: switch, toggle and option parts. */
export function isSwitchClass(name: string): boolean {
  return (
    /switch|toggle|segment|option|chip|radio/i.test(name) &&
    !/^model-switch-(?!chip)/.test(name)
  );
}
