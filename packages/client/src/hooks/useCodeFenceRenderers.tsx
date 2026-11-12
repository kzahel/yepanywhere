/**
 * Label rendered code blocks with their language, and hand the ones a
 * registered renderer claims to that renderer.
 *
 * Works on already-rendered markup rather than on source, so one hook covers
 * completed augments, streaming augments, and markdown file previews alike.
 * See `topics/code-fence-renderers.md`.
 */

import { lazy, type RefObject, Suspense, useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { RENDER_MODE_GLYPH_MARKUP } from "../components/ui/RenderModeGlyph";
import {
  type CodeFenceRenderer,
  getCodeFenceRenderer,
} from "../lib/codeFence/renderers";
import { writeClipboardText } from "../lib/clipboard";
import { createCodeGridNormalizer } from "../lib/codeFence/gridFont";
import { OUTPUT_APPEARANCE_CHANGE_EVENT } from "./useOutputAppearance";
import { getResolvedTheme } from "./useTheme";
import styles from "./useCodeFenceRenderers.module.css";

/**
 * Belongs on the container passed to `useCodeFenceRenderers`, so the hook's
 * stylesheet can scope under it. The hook enhances whatever container it is
 * given; this is the caller's half of that arrangement.
 */
export const codeFenceRootClass: string = styles.root ?? "";

/** Every fenced block, labeled or not, gets a copy control. */
const ANY_CODE_SELECTOR = "pre > code";
const LANGUAGE_CLASS = /(?:^|\s)language-(\S+)/;

/** How long a tap keeps the language label visible on a touch device. */
const LABEL_REVEAL_MS = 2500;

// The hook's own DOM contract. Styling scopes off these too, so the selectors
// its tests use are the selectors the stylesheet uses.
const BLOCK = "data-ya-code-block";
const RENDERED = "data-ya-code-rendered";
const TOGGLE = "data-ya-code-toggle";
const COPY = "data-ya-code-copy";
const EXPAND = "data-ya-code-expand";
const DiagramViewer = lazy(() => import("../components/DiagramViewer"));
const EXPAND_ICON_MARKUP =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"/></svg>';

/** How long the copy control shows its confirmation. */
const COPIED_MS = 1200;

const COPY_ICON_MARKUP =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="5" y="5" width="9" height="9" rx="1.5"/>' +
  '<path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>';

/**
 * Rendered markup, keyed by renderer, appearance, and source. A React
 * re-render replaces the container's markup wholesale, so without this a
 * stable code block would re-render its diagram on every unrelated update.
 *
 * Entries hold rendered SVG and a long session can scroll past many diagrams,
 * so the cache is bounded and evicts the oldest. Returning to an evicted
 * diagram re-renders it.
 */
const RENDER_CACHE_LIMIT = 50;
const renderCache = new Map<string, string | null>();

function cacheRender(key: string, markup: string | null): void {
  renderCache.set(key, markup);
  while (renderCache.size > RENDER_CACHE_LIMIT) {
    const oldest = renderCache.keys().next();
    if (oldest.done) {
      return;
    }
    renderCache.delete(oldest.value);
  }
}

function cacheKey(
  renderer: CodeFenceRenderer,
  source: string,
  appearance: string,
): string {
  // Length-prefixing the source keeps the key unambiguous: a language name
  // and an appearance never contain a pipe, and the length pins where the
  // source begins, so two different inputs cannot produce one key.
  return `${renderer.language}|${appearance}|${source.length}|${source}`;
}

/**
 * No `title`: the stylesheet already reveals the language on hover, and a
 * native tooltip on every code block would fire constantly while reading or
 * selecting code, a second later and saying the same word.
 */
function labelBlock(pre: HTMLElement, language: string): void {
  if (pre.dataset.yaCodeLanguage === language) {
    return;
  }
  pre.dataset.yaCodeLanguage = language;
  pre.setAttribute("aria-label", `${language} code block`);
}

/**
 * A copy control inside the block that copies the fence's verbatim content.
 * It is icon-only and marked copy-ignored, so text selections and Markdown
 * copies of the surrounding prose never pick it up.
 */
function addCopyButton(pre: HTMLElement): void {
  if (pre.querySelector(`:scope > [${COPY}]`)) {
    return;
  }
  const button = pre.ownerDocument.createElement("button");
  button.type = "button";
  button.setAttribute(COPY, "");
  button.dataset.markdownCopyIgnore = "true";
  button.setAttribute("aria-label", "Copy code");
  button.innerHTML = COPY_ICON_MARKUP;
  pre.prepend(button);
}

function makeToggle(doc: Document, renderer: CodeFenceRenderer): HTMLElement {
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.setAttribute(TOGGLE, "");
  toggle.innerHTML = RENDER_MODE_GLYPH_MARKUP;
  toggle.dataset.yaRenderedNoun = renderer.renderedNoun;
  return toggle;
}

/**
 * The label names the block, not just the view, because the enclosing
 * assistant message has its own source/rendered toggle: a bare "Show source"
 * on both leaves two buttons with one name in the same message.
 */
function describeToggle(toggle: HTMLElement, showingRendered: boolean): void {
  const noun = toggle.dataset.yaRenderedNoun ?? "rendered view";
  const label = showingRendered ? `Show ${noun} source` : `Show ${noun}`;
  toggle.setAttribute("aria-pressed", String(showingRendered));
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
}

function setView(block: HTMLElement, view: "rendered" | "source"): void {
  block.dataset.yaCodeView = view;
  const toggle = block.querySelector<HTMLElement>(`[${TOGGLE}]`);
  if (toggle) {
    describeToggle(toggle, view === "rendered");
  }
}

/**
 * Put `markup` beside `pre` inside a shared block wrapper, creating the
 * wrapper and its toggle on first use. The wrapper is what carries the
 * source-versus-rendered choice, so the toggle can hide either child.
 */
function mount(
  pre: HTMLElement,
  markup: string,
  key: string,
  renderer: CodeFenceRenderer,
  expandLabel: string,
): void {
  const doc = pre.ownerDocument;
  const parent = pre.parentElement;
  let block = parent?.hasAttribute(BLOCK) === true ? parent : undefined;

  if (!block) {
    block = doc.createElement("div");
    block.setAttribute(BLOCK, "");
    pre.replaceWith(block);
    block.append(pre);
    block.append(makeToggle(doc, renderer));
  }

  let rendered = block.querySelector<HTMLElement>(`[${RENDERED}]`);
  if (!rendered) {
    rendered = doc.createElement("div");
    rendered.setAttribute(RENDERED, "");
    block.insertBefore(rendered, pre);
  }
  rendered.innerHTML = markup;
  rendered.setAttribute("role", "button");
  rendered.tabIndex = 0;
  rendered.setAttribute("aria-label", expandLabel);
  if (!block.querySelector(`[${EXPAND}]`)) {
    const expand = doc.createElement("button");
    expand.type = "button";
    expand.setAttribute(EXPAND, "");
    expand.dataset.markdownCopyIgnore = "true";
    expand.setAttribute("aria-label", expandLabel);
    expand.title = expandLabel;
    expand.innerHTML = EXPAND_ICON_MARKUP;
    block.append(expand);
  }

  block.dataset.yaRenderKey = key;
  // A block the user has switched to source keeps that choice across
  // re-renders of its content.
  setView(block, block.dataset.yaCodeView === "source" ? "source" : "rendered");
}

async function renderBlock(
  pre: HTMLElement,
  code: HTMLElement,
  renderer: CodeFenceRenderer,
  expandLabel: string,
): Promise<void> {
  const source = code.textContent ?? "";
  if (source.trim() === "") {
    return;
  }

  const key = cacheKey(renderer, source, getResolvedTheme());
  const block = pre.closest(`[${BLOCK}]`);
  if (block instanceof HTMLElement && block.dataset.yaRenderKey === key) {
    return;
  }
  // One attempt per exact source. A streaming block whose source grows gets a
  // new key and is tried again; one that declined is not retried in a loop.
  if (pre.dataset.yaRenderAttempt === key) {
    return;
  }
  pre.dataset.yaRenderAttempt = key;

  let markup = renderCache.get(key);
  if (markup === undefined) {
    markup = await renderer.render(source);
    cacheRender(key, markup);
  }
  if (markup === null || !pre.isConnected) {
    return;
  }

  mount(pre, markup, key, renderer, expandLabel);
}

function enhance(
  root: ParentNode,
  normalizeGrid: (code: HTMLElement) => Promise<void>,
  expandLabel: string,
): void {
  for (const code of root.querySelectorAll<HTMLElement>(ANY_CODE_SELECTOR)) {
    const pre = code.parentElement;
    if (pre) {
      addCopyButton(pre);
      // Raw message text contains React-owned links and text nodes. Replacing
      // those nodes breaks reconciliation when issue metadata or text changes.
      if (!pre.hasAttribute("data-text-block-source")) {
        void normalizeGrid(code).catch((error: unknown) =>
          window.reportError(error),
        );
      }
    }
  }
  for (const code of root.querySelectorAll<HTMLElement>(ANY_CODE_SELECTOR)) {
    const pre = code.parentElement;
    if (!pre) {
      continue;
    }
    const language = LANGUAGE_CLASS.exec(code.className)?.[1]?.toLowerCase();
    if (!language) {
      continue;
    }

    labelBlock(pre, language);

    const renderer = getCodeFenceRenderer(language);
    if (renderer) {
      void renderBlock(pre, code, renderer, expandLabel);
    }
  }
}

/**
 * Enhance every rendered code block inside `rootRef`, and keep doing it as
 * the container's content changes.
 */
export function useCodeFenceRenderers(rootRef: RefObject<HTMLElement | null>) {
  const { t } = useI18n();
  const expandLabel = t("diagramViewerOpen");
  const [diagram, setDiagram] = useState<string | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    let scheduled = false;
    let labelTimer: number | undefined;
    const grid = createCodeGridNormalizer(root.ownerDocument);

    const refresh = () => {
      scheduled = false;
      enhance(root, grid.normalize, expandLabel);
    };

    // Streaming augments mutate the container per token, so coalesce to one
    // pass per frame rather than scanning on every mutation.
    const schedule = () => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(refresh);
      } else {
        window.setTimeout(refresh, 0);
      }
    };

    const onClick = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const diagramTarget = target.closest(`[${EXPAND}], [${RENDERED}]`);
      const svg = diagramTarget?.closest(`[${BLOCK}]`)?.querySelector("svg");
      if (diagramTarget && svg && root.contains(diagramTarget)) {
        event.stopPropagation();
        event.preventDefault();
        // Keep Mermaid's own styles and XHTML namespaces in the standalone
        // vector. Explicit dimensions avoid an SVG image's 300x150 fallback.
        const standalone = svg.cloneNode(true) as SVGSVGElement;
        const bounds = svg.viewBox.baseVal;
        standalone.setAttribute(
          "width",
          String(bounds.width || svg.clientWidth),
        );
        standalone.setAttribute(
          "height",
          String(bounds.height || svg.clientHeight),
        );
        standalone.style.maxWidth = "none";
        setDiagram(new XMLSerializer().serializeToString(standalone));
        return;
      }

      const copy = target.closest<HTMLElement>(`[${COPY}]`);
      if (copy && root.contains(copy)) {
        event.stopPropagation();
        event.preventDefault();
        // The block's own text is the fence verbatim; the control adds none.
        const source =
          copy.parentElement?.querySelector(":scope > code")?.textContent ?? "";
        void writeClipboardText(source).then((copied) => {
          if (!copied) return;
          copy.dataset.yaCodeCopied = "true";
          copy.setAttribute("aria-label", "Copied");
          window.setTimeout(() => {
            delete copy.dataset.yaCodeCopied;
            copy.setAttribute("aria-label", "Copy code");
          }, COPIED_MS);
        });
        return;
      }

      const toggle = target.closest(`[${TOGGLE}]`);
      const block = toggle?.closest(`[${BLOCK}]`);
      if (toggle && block instanceof HTMLElement) {
        // The enclosing transcript row treats content clicks as link/media
        // gestures; this one is ours.
        event.stopPropagation();
        event.preventDefault();
        setView(
          block,
          block.dataset.yaCodeView === "source" ? "rendered" : "source",
        );
        return;
      }

      // Tap-to-reveal, so the language is reachable without a hover pointer.
      const pre = target.closest<HTMLElement>("pre[data-ya-code-language]");
      if (!pre) {
        return;
      }
      for (const shown of root.querySelectorAll<HTMLElement>(
        "pre[data-ya-code-language-shown]",
      )) {
        delete shown.dataset.yaCodeLanguageShown;
      }
      pre.dataset.yaCodeLanguageShown = "1";
      window.clearTimeout(labelTimer);
      labelTimer = window.setTimeout(() => {
        delete pre.dataset.yaCodeLanguageShown;
      }, LABEL_REVEAL_MS);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.key === "Enter" || event.key === " ") &&
        event.target instanceof HTMLElement &&
        event.target.hasAttribute(RENDERED)
      ) {
        event.preventDefault();
        event.target.click();
      }
    };

    refresh();
    const appearanceChanged = () => {
      grid.invalidate();
      schedule();
    };
    window.addEventListener(OUTPUT_APPEARANCE_CHANGE_EVENT, appearanceChanged);
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeyDown);
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    // A rendered diagram carries its own colors, so it has to be redrawn when
    // YA's light/dark appearance changes. The cache key includes appearance,
    // so a refresh is all this needs.
    const themeObserver = new MutationObserver(schedule);
    themeObserver.observe(root.ownerDocument.documentElement, {
      attributeFilter: ["data-theme"],
      attributes: true,
    });
    const systemDark = root.ownerDocument.defaultView?.matchMedia?.(
      "(prefers-color-scheme: dark)",
    );
    systemDark?.addEventListener?.("change", schedule);

    return () => {
      observer.disconnect();
      grid.dispose();
      window.removeEventListener(
        OUTPUT_APPEARANCE_CHANGE_EVENT,
        appearanceChanged,
      );
      themeObserver.disconnect();
      systemDark?.removeEventListener?.("change", schedule);
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(labelTimer);
    };
  }, [expandLabel, rootRef]);

  return diagram ? (
    <Suspense fallback={null}>
      <DiagramViewer svg={diagram} onClose={() => setDiagram(null)} />
    </Suspense>
  ) : null;
}
