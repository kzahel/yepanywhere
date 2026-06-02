/**
 * Tauri detection and helpers for the web client.
 *
 * The web UI (this package) runs inside the Tauri desktop webview, but it is
 * served by the local server — the `@tauri-apps/api` package is NOT bundled
 * here. We therefore detect Tauri and talk to its plugins through the globals
 * Tauri injects into the webview (`window.__TAURI_INTERNALS__`).
 */

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
    /** Present when withGlobalTauri is enabled; used only as a fallback signal. */
    __TAURI__?: unknown;
  }
}

/** True when running inside the Tauri desktop webview. */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined
  );
}

/**
 * Open a URL in the user's default system browser via the Tauri opener plugin.
 *
 * Falls back to `window.open` if the plugin invoke is unavailable or fails, so
 * a misconfigured permission never leaves the link completely dead.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const internals =
    typeof window !== "undefined" ? window.__TAURI_INTERNALS__ : undefined;

  if (internals?.invoke) {
    try {
      await internals.invoke("plugin:opener|open_url", { url });
      return;
    } catch {
      // Fall through to window.open below.
    }
  }

  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
