/**
 * Browser-safe half of the element-based button census: the row type the
 * scan in buttonElements.ts produces, and which later family a raw button
 * belongs to. The census page and the button ban share it.
 */

export type ButtonElementKind =
  | "raw"
  | "shared"
  | "link"
  | "label"
  | "role-button";

export interface ButtonElement {
  /** Path relative to src/, with forward slashes. */
  file: string;
  line: number;
  /** The tag as written: button, Button, a, Link, label, div, … */
  tag: string;
  kind: ButtonElementKind;
  /** The className attribute's source text, if any. */
  className?: string;
  /** A literal role attribute, if any. */
  role?: string;
}

/** Families that keep raw buttons until their own pass (plan 182). */
export type RawButtonFamily = "menu" | "tab" | "option" | "switch" | "composer";

const ROLE_FAMILIES: Record<string, RawButtonFamily> = {
  menuitem: "menu",
  menuitemcheckbox: "menu",
  menuitemradio: "menu",
  tab: "tab",
  option: "option",
  radio: "option",
  switch: "switch",
};

/** The session composer's files: excluded until the composer's own pass. */
export const COMPOSER_FILE =
  /^components\/(?:MessageInput[^/]*|Composer[^/]*|VoiceInputButton|SlashCommandButton|ThinkingToolbarControl|ModeSelector|AttachmentButton|BrowserDebugToolbarButton|FullPaneComposerToggle)\.tsx$/;

/**
 * Which later family a raw button belongs to, judged from its role, its
 * file, an option-picker class (`*-option`, `styles.*Option`) or a switch
 * class (`toggle-switch`, `styles.switch`); undefined for a button the
 * button family itself should swap.
 */
export function rawButtonFamily(
  row: Pick<ButtonElement, "file" | "role" | "className">,
): RawButtonFamily | undefined {
  const byRole = row.role ? ROLE_FAMILIES[row.role] : undefined;
  if (byRole) return byRole;
  if (COMPOSER_FILE.test(row.file)) return "composer";
  if (row.className && /[\w-]-option\b|styles\.\w*Option\b/.test(row.className))
    return "option";
  if (row.className && /toggle-switch|styles\.switch\b/.test(row.className))
    return "switch";
  return undefined;
}
