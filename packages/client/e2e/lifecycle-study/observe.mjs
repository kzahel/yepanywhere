/** Runs unchanged inside Chromium and the actual Android WebView. No app hooks. */
export function installObserver() {
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", installObserver, {
      once: true,
    });
    return;
  }
  if (window.__lifecycleStudy) return;
  const rows = [];
  const keys = [];
  let previous = "";
  let hasContent = false;
  const visible = (element) =>
    element instanceof HTMLElement &&
    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const text = (selector) =>
    [...document.querySelectorAll(selector)]
      .filter(visible)
      .map((e) => e.textContent.trim())
      .join(" | ")
      .slice(0, 1600);
  const sample = () => {
    const composer = document.querySelector("textarea[data-composer-input]");
    const bodyEmpty = !document.body.innerText.trim();
    hasContent ||= !bodyEmpty;
    const state = {
      path: location.pathname,
      visibility: document.visibilityState,
      online: navigator.onLine,
      connection: [...document.querySelectorAll("[data-connection-status]")]
        .filter(visible)
        .map((element) => element.getAttribute("data-connection-status"))
        .join(","),
      errors: text('[data-error], [role="alert"], [class*="errorMessage"]'),
      loading: text("[data-loading]"),
      draftNotice: text("[data-draft-notice]"),
      attachments: text("[data-attachment-list]"),
      attachmentNames: [
        ...document.querySelectorAll(
          '[data-attachment-list] button[aria-label^="Remove "]',
        ),
      ]
        .filter(visible)
        .map((button) => button.getAttribute("aria-label").slice(7)),
      login: [
        ...document.querySelectorAll(
          '[data-testid="login-form"], [data-testid="relay-login-form"]',
        ),
      ].some(visible),
      heading: text("h1, header"),
      sidebar: text("[data-sidebar]"),
      main: text("main").slice(-1600),
      draft: composer?.value ?? null,
      bodyEmpty,
      initializing: !hasContent,
    };
    const signature = JSON.stringify(state);
    if (signature !== previous) {
      previous = signature;
      rows.push({ at: Date.now(), ...state });
      if (rows.length > 4000) rows.shift();
    }
    return state;
  };
  const observer = new MutationObserver(sample);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "data-connection-status"],
  });
  document.addEventListener("visibilitychange", sample);
  window.addEventListener("online", sample);
  window.addEventListener("offline", sample);
  document.addEventListener("input", (event) => {
    if (!event.target?.matches?.("textarea[data-composer-input]")) return;
    const began = performance.now();
    const value = event.target.value;
    requestAnimationFrame(() => {
      if (keys.length < 2000)
        keys.push({
          at: Date.now(),
          value,
          frameDelayMs: performance.now() - began,
          eventDelayMs: Math.max(0, began - event.timeStamp),
        });
    });
    sample();
  });
  window.__lifecycleStudy = { rows, keys, sample };
  sample();
}
