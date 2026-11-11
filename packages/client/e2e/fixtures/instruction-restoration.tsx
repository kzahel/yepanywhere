import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_INSTRUCTION_RESTORATION } from "@yep-anywhere/shared";
import { I18nProvider } from "../../src/i18n";
import { InstructionRestorationControl } from "../../src/pages/settings/InstructionRestorationControl";
import "../../src/styles/purposeGlobals";

function Fixture() {
  const [updates, setUpdates] = useState(0);
  const [saved, setSaved] = useState(DEFAULT_INSTRUCTION_RESTORATION);
  useEffect(() => {
    const timer = setInterval(() => setUpdates((n) => n + 1), 25);
    return () => clearInterval(timer);
  }, []);
  return (
    <main
      style={{ padding: 12, maxWidth: 900, margin: "auto" }}
      data-updates={updates}
      data-saved={JSON.stringify(saved)}
    >
      <InstructionRestorationControl
        value={saved}
        providers={[
          { id: "codex", displayName: "Codex" },
          { id: "claude", displayName: "Claude" },
        ]}
        save={async (value) => setSaved(value)}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <MemoryRouter>
      <Fixture />
    </MemoryRouter>
  </I18nProvider>,
);
