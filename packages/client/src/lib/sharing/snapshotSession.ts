/**
 * Capture the currently rendered session as a standalone HTML document.
 * Grabs all stylesheets and the message list DOM, strips interactive elements.
 */

import { querySessionRouteLayerElement } from "../sessionRouteLayer";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function snapshotSession(title?: string): string {
  // 1. Collect all stylesheet rules
  const styles: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        styles.push(rule.cssText);
      }
    } catch {
      // Cross-origin stylesheets — skip
    }
  }

  // 2. Clone the session messages container
  const messagesEl = querySessionRouteLayerElement(
    "main[data-session-messages]",
  );
  if (!messagesEl) {
    throw new Error("Session messages not found");
  }
  const clone = messagesEl.cloneNode(true) as HTMLElement;

  // 3. Strip interactive and transient elements
  const removeSelectors = [
    "button",
    "input",
    "textarea",
    "[contenteditable]",
    "script",
    ".session-menu-wrapper",
    "[data-load-older-messages]",
    "[data-pending-message]",
    "[data-deferred-message]",
    "[data-processing-indicator]",
  ];
  for (const el of clone.querySelectorAll(removeSelectors.join(", "))) {
    el.remove();
  }

  // 4. Strip event handler attributes
  for (const el of clone.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("on")) {
        el.removeAttribute(attr.name);
      }
    }
  }

  // 5. Preserve theme via root element classes and data-theme attribute
  const htmlClasses = document.documentElement.className;
  const bodyClasses = document.body.className;
  const dataTheme = document.documentElement.getAttribute("data-theme");

  const displayTitle = title || "Shared Session";

  return `<!DOCTYPE html>
<html class="${escapeHtml(htmlClasses)}"${dataTheme ? ` data-theme="${escapeHtml(dataTheme)}"` : ""} lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(displayTitle)}</title>
<style>
${styles.join("\n")}
/* Snapshot overrides */
*, *::before, *::after {
  pointer-events: none !important;
  user-select: text !important;
}
a[href] {
  pointer-events: auto !important;
}
body {
  margin: 0;
  padding: 1rem;
  overflow-y: auto;
}
main[data-session-messages] {
  overflow: visible;
  height: auto;
}
</style>
</head>
<body class="${escapeHtml(bodyClasses)}">
${clone.outerHTML}
<footer style="text-align:center;padding:2rem 0 1rem;opacity:0.5;font-size:12px;pointer-events:auto;user-select:auto;">
Shared from <a href="https://yepanywhere.com" style="pointer-events:auto">Yep Anywhere</a>
</footer>
</body>
</html>`;
}
