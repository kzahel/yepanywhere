/**
 * Settings of this Chrome profile's YA extension, kept in
 * `chrome.storage.local` so the side panel, the app pages and the background
 * worker read one copy. They belong to the browser, not to any YA host.
 */

import { getChrome, type ChromeStorageChange } from "./chrome";

export const EXTENSION_SETTINGS_KEY = "ya.extension.settings";

export interface ExtensionSettings {
  /**
   * Saved-host ids the extension uses outside the YA tab. Null means every
   * saved relay host, so a first sign-in works without visiting settings.
   */
  activeHostIds: string[] | null;
  /** Host that receives "new session about this page"; null is the first active. */
  defaultHostId: string | null;
  /** Look up issue pages on granted sites as tabs navigate. */
  automaticLookup: boolean;
  /**
   * Repository (`owner/repo`, `owner/*`) and Jira project (`TF`) patterns a
   * page must match before its URL is sent to a host. Empty sends any issue
   * page on a granted site.
   */
  lookupAllowlist: string[];
  includeDismissed: boolean;
  collapseMergedPrs: boolean;
  toolbarAction: "side-panel" | "app-tab";
  badge: "page" | "off";
  /**
   * The session groups the side panel lists on every page, below the page's
   * own context. The name predates showing them on issue and session pages.
   */
  panelFallback: "attention" | "recent" | "none";
  openSessionsIn: "existing-tab" | "new-tab";
  /** What a newly opened YA page is: a browser tab or a popup window. */
  appWindow: "tab" | "popup";
}

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  activeHostIds: null,
  defaultHostId: null,
  automaticLookup: true,
  lookupAllowlist: [],
  includeDismissed: false,
  collapseMergedPrs: false,
  toolbarAction: "side-panel",
  badge: "page",
  panelFallback: "attention",
  openSessionsIn: "existing-tab",
  appWindow: "tab",
};

function normalize(value: unknown): ExtensionSettings {
  const stored =
    value && typeof value === "object"
      ? (value as Partial<ExtensionSettings>)
      : {};
  const pick = <K extends keyof ExtensionSettings>(
    key: K,
    valid: (candidate: unknown) => boolean,
  ): ExtensionSettings[K] =>
    valid(stored[key])
      ? (stored[key] as ExtensionSettings[K])
      : DEFAULT_EXTENSION_SETTINGS[key];
  const strings = (candidate: unknown) =>
    Array.isArray(candidate) &&
    candidate.every((item) => typeof item === "string");
  return {
    activeHostIds: pick(
      "activeHostIds",
      (candidate) => candidate === null || strings(candidate),
    ),
    defaultHostId: pick(
      "defaultHostId",
      (candidate) => candidate === null || typeof candidate === "string",
    ),
    automaticLookup: pick(
      "automaticLookup",
      (candidate) => typeof candidate === "boolean",
    ),
    lookupAllowlist: pick("lookupAllowlist", strings),
    includeDismissed: pick(
      "includeDismissed",
      (candidate) => typeof candidate === "boolean",
    ),
    collapseMergedPrs: pick(
      "collapseMergedPrs",
      (candidate) => typeof candidate === "boolean",
    ),
    toolbarAction: pick("toolbarAction", (candidate) =>
      ["side-panel", "app-tab"].includes(candidate as string),
    ),
    badge: pick("badge", (candidate) =>
      ["page", "off"].includes(candidate as string),
    ),
    panelFallback: pick("panelFallback", (candidate) =>
      ["attention", "recent", "none"].includes(candidate as string),
    ),
    openSessionsIn: pick("openSessionsIn", (candidate) =>
      ["existing-tab", "new-tab"].includes(candidate as string),
    ),
    appWindow: pick("appWindow", (candidate) =>
      ["tab", "popup"].includes(candidate as string),
    ),
  };
}

export async function loadExtensionSettings(): Promise<ExtensionSettings> {
  const chrome = getChrome();
  if (!chrome) return DEFAULT_EXTENSION_SETTINGS;
  const stored = await chrome.storage.local.get(EXTENSION_SETTINGS_KEY);
  return normalize(stored[EXTENSION_SETTINGS_KEY]);
}

export async function updateExtensionSettings(
  change: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const chrome = getChrome();
  if (!chrome) throw new Error("Extension settings are unavailable here");
  const next = { ...(await loadExtensionSettings()), ...change };
  await chrome.storage.local.set({ [EXTENSION_SETTINGS_KEY]: next });
  return next;
}

export function subscribeExtensionSettings(
  listener: (settings: ExtensionSettings) => void,
): () => void {
  const chrome = getChrome();
  if (!chrome) return () => {};
  const changed = (
    changes: Record<string, ChromeStorageChange>,
    area: string,
  ) => {
    const change = changes[EXTENSION_SETTINGS_KEY];
    if (area === "local" && change) listener(normalize(change.newValue));
  };
  chrome.storage.onChanged.addListener(changed);
  return () => chrome.storage.onChanged.removeListener(changed);
}

/**
 * Whether an issue page may be sent to a host under the allowlist. GitHub
 * keys are `owner/repo#n`; Jira keys are `PROJECT-n`.
 */
export function allowlistPermits(allowlist: string[], key: string): boolean {
  const patterns = allowlist
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (patterns.length === 0) return true;
  const lower = key.toLowerCase();
  const repository = lower.includes("#") ? lower.split("#")[0]! : null;
  const project = repository === null ? lower.split("-")[0]! : null;
  return patterns.some((pattern) => {
    if (repository !== null) {
      if (pattern.endsWith("/*"))
        return repository.startsWith(pattern.slice(0, -1));
      return repository === pattern;
    }
    return !pattern.includes("/") && project === pattern;
  });
}
