import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TextBlock } from "../../src/components/blocks/TextBlock";
import { I18nProvider } from "../../src/i18n";
import "../../src/styles/purposeGlobals";

interface Response {
  text: string;
  html: string;
}
function Fixture() {
  const [response, setResponse] = useState<Response>();
  const [draft, setDraft] = useState("");
  useEffect(() => {
    let stopped = false;
    let timer: number;
    const next = async () => {
      const latest: Response = await (await fetch("/citation-response")).json();
      if (!stopped) {
        setResponse(latest);
        timer = window.setTimeout(next, 80);
      }
    };
    void next();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <main
      style={{
        maxWidth: 760,
        margin: "auto",
        padding: "20px 16px 120px",
        color: "var(--text-primary)",
      }}
    >
      <h2>Web citations</h2>
      <section aria-label="Latest answer" style={{ minHeight: 270 }}>
        {response && (
          <TextBlock
            text={response.text}
            augmentHtml={response.html}
            paragraphQuoteCirclesEnabled={false}
          />
        )}
      </section>
      <section aria-label="History">
        {Array.from({ length: 200 }, (_, i) => (
          <TextBlock
            key={i}
            text={`Earlier response ${i}`}
            augmentHtml={`<p>Earlier response ${i}</p>`}
            paragraphQuoteCirclesEnabled={false}
          />
        ))}
      </section>
      <label
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          padding: 16,
          background: "var(--bg-primary)",
        }}
      >
        Message
        <textarea
          aria-label="Message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ display: "block", width: "100%", height: 55 }}
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
