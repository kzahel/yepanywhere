import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../../src/i18n";
import { UsersSettings } from "../../src/pages/settings/UsersSettings";
import "../../src/styles/purposeGlobals";

function Fixture() {
  const [updates, setUpdates] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setUpdates((value) => value + 1), 25);
    return () => clearInterval(timer);
  }, []);
  return (
    <main
      style={{ padding: 12, maxWidth: 850, margin: "auto" }}
      data-testid="background-updates"
      data-updates={updates}
    >
      <UsersSettings />
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
