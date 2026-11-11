import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n";
import { PromptHistoryRail } from "../../src/components/PromptHistoryRail";
import { rememberComposerPrompt } from "../../src/lib/composerHistory";
import { UI_KEYS } from "../../src/lib/storageKeys";
import "../../src/styles/purposeGlobals";

// The rail is opt-in; `?rail=off` exercises the default.
localStorage.setItem(
  UI_KEYS.composerPromptRail,
  String(new URLSearchParams(location.search).get("rail") !== "off"),
);

await Promise.all(
  Array.from({ length: 50 }, (_, i) =>
    rememberComposerPrompt(
      "rail-test",
      i === 49
        ? "Let the rider turn around."
        : `Recent prompt ${i}: ${"A long wrapped prompt. ".repeat(30)}`,
    ),
  ),
);
function Fixture() {
  const [value, setValue] = useState("Before\n\nAfter");
  const [tick, setTick] = useState(0);
  const [scope, setScope] = useState("rail-test");
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 40);
    return () => clearInterval(timer);
  }, []);
  return (
    <main style={{ maxWidth: 820, margin: "24px auto", padding: "0 12px" }}>
      <h1>New session</h1>
      <PromptHistoryRail
        scope={scope}
        textareaRef={textarea}
        onChange={setValue}
      >
        <textarea
          aria-label="Prompt"
          ref={textarea}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          style={{
            boxSizing: "border-box",
            width: "100%",
            height: 210,
            padding: 12,
            border: "1px solid var(--border-input)",
            borderRadius: 8,
            font: "16px/24px monospace",
            color: "var(--text-primary)",
            background: "var(--bg-secondary)",
          }}
        />
      </PromptHistoryRail>
      <button type="button" onClick={() => setScope("other-account")}>
        Switch account
      </button>
      <output aria-label="Concurrent updates">{tick}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <Fixture />
  </I18nProvider>,
);
