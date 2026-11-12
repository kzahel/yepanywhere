import markdownStyles from "../../src/components/MarkdownPreview.module.css";
import textStyles from "../../src/components/blocks/TextBlock.module.css";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n";
import { TextBlock } from "../../src/components/blocks/TextBlock";
import { IssueMentionLinksContext } from "../../src/components/IssueMentionText";
import {
  codeFenceRootClass,
  useCodeFenceRenderers,
} from "../../src/hooks/useCodeFenceRenderers";
import "../../src/styles/purposeGlobals";

const board = "┌────────────┐\n│█◎●→·○◯◆■□  │\n│0123456789AB│\n└────────────┘";

function Fixture() {
  const ref = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("");
  const [issueLinks, setIssueLinks] = useState(false);
  useCodeFenceRenderers(ref);
  useEffect(() => {
    const code = ref.current!.querySelector("#stream code")!;
    let tick = 0;
    const interval = window.setInterval(() => {
      code.textContent = `${board}\nframe ${++tick}`;
    }, 40);
    return () => window.clearInterval(interval);
  }, []);
  return (
    <main
      style={
        {
          padding: 16,
          maxWidth: 800,
          margin: "auto",
          color: "var(--text-primary)",
          "--font-mono": '"YA Iosevka", monospace',
          "--fixed-font-size-sm": "16px",
        } as React.CSSProperties
      }
    >
      <h2>Readable code blocks</h2>
      <IssueMentionLinksContext.Provider
        value={
          issueLinks
            ? {
                pattern: /#42/g,
                destinations: new Map([
                  ["#42", "https://example.org/issues/42"],
                ]),
              }
            : null
        }
      >
        <section id="react-source">
          <TextBlock text="before ◯ #42 after" />
        </section>
      </IssueMentionLinksContext.Provider>
      <button type="button" onClick={() => setIssueLinks((value) => !value)}>
        Refresh issue links
      </button>
      <div
        ref={ref}
        className={`${textStyles.textBlock} ${markdownStyles.markdownRendered} ${codeFenceRootClass}`}
        data-text-block
        data-markdown-rendered
      >
        <p>Copy stays above the source, including long wrapped comments.</p>
        <pre id="android">
          <code className="language-kotlin">
            {"minSdk = 28     "}
            <span style={{ color: "var(--shiki-token-comment)" }}>
              {"// Runs on Android 9 and newer"}
            </span>
            {"\ntargetSdk = 36  "}
            <span style={{ color: "var(--shiki-token-comment)" }}>
              {"// Uses modern Android behavior rules"}
            </span>
            {"\ncompileSdk = 36"}
          </code>
        </pre>
        <p>Symbols retain the same columns as letters and spaces.</p>
        <pre id="board">
          <code>{board}</code>
        </pre>
        <p>Ordinary code keeps Iosevka.</p>
        <pre id="ordinary">
          <code className="language-typescript">
            {"const café = '中文 👩‍💻';\nconsole.log(café);"}
          </code>
        </pre>
        <pre id="single">
          <code>{"before ◯ after"}</code>
        </pre>
        <pre id="ascii">
          <code>{"+--------+\n|  art   |\n+--------+"}</code>
        </pre>
        <pre id="stream">
          <code>{board}</code>
        </pre>
        <div id="history" />
      </div>
      <label>
        Message
        <textarea
          aria-label="Message"
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            setIssueLinks((value) => !value);
          }}
          style={{ display: "block", width: "100%" }}
        />
      </label>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <Fixture />
  </I18nProvider>,
);
