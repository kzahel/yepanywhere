import type { useI18n } from "../i18n";
import type { SessionIsearchScope } from "../lib/sessionIsearchGuide";
type ToolbarTranslate = ReturnType<typeof useI18n>["t"];

export function getIsearchPreviousKeys(scope: SessionIsearchScope): string[] {
  if (scope === "links") {
    return ["Ctrl", "Alt", "K"];
  }
  if (scope === "full") {
    return ["Ctrl", "Alt", "S"];
  }
  if (scope === "all") {
    return ["Ctrl", "S"];
  }
  return ["Ctrl", "R"];
}

export function getIsearchAlternateRows(
  scope: SessionIsearchScope,
  t: ToolbarTranslate,
): Array<{
  scope: SessionIsearchScope;
  keys: string[];
  label: string;
}> {
  return [
    ...(scope === "user"
      ? []
      : [
          {
            scope: "user" as const,
            keys: ["Ctrl", "R"],
            label: t("toolbarShortcutUserTurns"),
          },
        ]),
    ...(scope === "all"
      ? []
      : [
          {
            scope: "all" as const,
            keys: ["Ctrl", "S"],
            label: t("toolbarShortcutAllTurns"),
          },
        ]),
    ...(scope === "full"
      ? []
      : [
          {
            scope: "full" as const,
            keys: ["Ctrl", "Alt", "S"],
            label: t("toolbarShortcutFullSession"),
          },
        ]),
    ...(scope === "links"
      ? []
      : [
          {
            scope: "links" as const,
            keys: ["Ctrl", "Alt", "K"],
            label: t("toolbarShortcutLinks"),
          },
        ]),
  ];
}

export function isCtrlKeyShortcut(
  event: KeyboardEvent,
  key: string,
  code: string,
  options: { allowAlt?: boolean } = {},
): boolean {
  if (
    !event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    (!options.allowAlt && event.altKey) ||
    event.getModifierState("AltGraph")
  ) {
    return false;
  }
  return event.key.toLocaleLowerCase() === key || event.code === code;
}

export function getSessionIsearchShortcutScope(
  event: KeyboardEvent,
): SessionIsearchScope | null {
  if (
    isCtrlKeyShortcut(event, "s", "KeyS", { allowAlt: true }) &&
    event.altKey
  ) {
    return "full";
  }
  if (isCtrlKeyShortcut(event, "s", "KeyS")) {
    return "all";
  }
  if (isCtrlKeyShortcut(event, "r", "KeyR", { allowAlt: true })) {
    return "user";
  }
  if (
    isCtrlKeyShortcut(event, "k", "KeyK", { allowAlt: true }) &&
    event.altKey
  ) {
    return "links";
  }
  return null;
}
