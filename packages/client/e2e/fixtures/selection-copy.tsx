import markdownStyles from "../../src/components/MarkdownPreview.module.css";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n";
import { useSelectionActionPresentation } from "../../src/hooks/useSelectionActionPresentation";
import { useQuoteableTextSource } from "../../src/hooks/useQuoteableTextSource";
import { UserPromptBlock } from "../../src/components/blocks/UserPromptBlock";
import "../../src/styles/index.css";
import "../../src/styles/renderers.css";

function HistoryBlock({ index }: { index: number }) {
  const ref = useQuoteableTextSource<HTMLParagraphElement>(
    `Earlier response ${index}.`,
  );
  return <p ref={ref}>Earlier response {index}.</p>;
}
function Fixture() {
  const root = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const source = useQuoteableTextSource<HTMLDivElement>(
    `Copy this into the new session:

> Continue the **Android preview** in \`/Users/project\`.
>
> Keep test data disposable.

Plain assistant text.`,
  );
  const rawSource = useQuoteableTextSource<HTMLPreElement>(
    "**literal_source**",
    undefined,
    "literal",
  );
  const [value, setValue] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 40);
    return () => clearInterval(timer);
  }, []);
  const actions = useSelectionActionPresentation({
    containerRef: root,
    inert: false,
    isInteractiveTarget: (target) =>
      target instanceof Element && !!target.closest("textarea, button"),
    onQuoteSelection: (text) => text,
    applyQuoteAnchors: (anchors) => {
      setValue(anchors.map((anchor) => anchor.quotedText).join("\n\n"));
      composer.current?.focus();
      return true;
    },
    applyQuoteFromSelection: () => false,
  });
  return (
    <main
      style={{
        maxWidth: 800,
        margin: "0 auto",
        padding: "24px 16px 220px",
        color: "var(--text-primary)",
      }}
    >
      <h2>Session</h2>
      <div ref={root} style={{ position: "relative" }}>
        <div
          ref={source}
          className={markdownStyles.markdownRendered}
          data-markdown-rendered
          data-testid="copy-source"
        >
          <p>Copy this into the new session:</p>
          <blockquote>
            <p>
              Continue the <strong>Android preview</strong> in{" "}
              <code>/Users/project</code>.
            </p>
            <p>Keep test data disposable.</p>
          </blockquote>
          <p data-testid="plain-selection">Plain assistant text.</p>
        </div>
        <div data-testid="user-selection">
          <UserPromptBlock
            content={[{ type: "text", text: "Use `long_command` literally." }]}
          />
        </div>
        <pre ref={rawSource} data-testid="raw-selection">
          {"**literal_source**"}
        </pre>
        {Array.from({ length: 250 }, (_, i) => (
          <HistoryBlock key={i} index={i} />
        ))}
        {actions.floatingSelectionActions}
      </div>
      <footer
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: "var(--bg-secondary)",
          padding: "12px 16px",
          borderTop: "1px solid var(--border-color)",
        }}
      >
        <div data-selection-actions-mobile-slot />
        <textarea
          aria-label="Message"
          ref={composer}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          style={{
            boxSizing: "border-box",
            width: "100%",
            height: 72,
            padding: 10,
            font: "16px sans-serif",
            color: "var(--text-primary)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-color)",
            borderRadius: 8,
          }}
        />
        <output aria-label="Concurrent updates">Updates: {tick}</output>
      </footer>
      {actions.mobileSelectionActions}
      {actions.selectionContextMenu}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <Fixture />
  </I18nProvider>,
);
