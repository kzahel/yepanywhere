import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../../src/i18n";
import { useLimitedUserBrowserDefaults } from "../../src/hooks/useLimitedUserBrowserDefaults";
import { UI_KEYS } from "../../src/lib/storageKeys";
import { UsersSettings } from "../../src/pages/settings/UsersSettings";
import "../../src/styles/purposeGlobals";

/** What App mounts for everyone; shows the value it would have applied. */
function Probe() {
  useLimitedUserBrowserDefaults();
  const [loads] = useState(() => {
    const count = Number(sessionStorage.getItem("probe-loads") ?? "0") + 1;
    sessionStorage.setItem("probe-loads", String(count));
    return count;
  });
  return (
    <output aria-label="Theme" data-loads={loads}>
      {localStorage.getItem(UI_KEYS.theme) ?? "unset"}
    </output>
  );
}

function Fixture() {
  const [updates, setUpdates] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setUpdates((value) => value + 1), 25);
    return () => clearInterval(timer);
  }, []);
  return (
    <main
      style={{ padding: 12, maxWidth: 850, margin: "auto" }}
      data-updates={updates}
    >
      <Probe />
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
