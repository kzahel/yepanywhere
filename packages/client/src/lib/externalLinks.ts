/**
 * Global handler that keeps external links from navigating the desktop webview.
 *
 * In the Tauri desktop app the webview points directly at the local server's
 * web UI. A plain `<a href="https://...">` click (e.g. a link in a chat
 * message) performs a top-level navigation, replacing the app with the external
 * page. Navigating back then reloads the document without the in-memory desktop
 * auth token, bricking the UI with 401s. To avoid this, external http(s) links
 * are opened in the system browser and the in-app navigation is cancelled.
 *
 * No-op outside Tauri — regular browsers handle links natively.
 */
import { isTauri, openExternalUrl } from "./tauri";

function isExternalHttpLink(anchor: HTMLAnchorElement): boolean {
  // anchor.href is always absolute; protocol/origin are resolved by the DOM.
  if (anchor.protocol !== "http:" && anchor.protocol !== "https:") {
    return false;
  }
  return anchor.origin !== window.location.origin;
}

export function installExternalLinkHandler(): () => void {
  if (!isTauri()) {
    return () => {};
  }

  const onClick = (event: MouseEvent) => {
    // Respect modifier-click and non-primary buttons handled elsewhere.
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    const target = event.target as Element | null;
    const anchor = target?.closest("a");
    if (!anchor?.getAttribute("href")) return;
    if (!isExternalHttpLink(anchor)) return;

    event.preventDefault();
    void openExternalUrl(anchor.href);
  };

  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
