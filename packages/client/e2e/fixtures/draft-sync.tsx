import { DraftSyncNotice } from "../../src/components/DraftSyncNotice";
import {
  SidebarNavItem,
  SidebarIcons,
} from "../../src/components/SidebarNavItem";
import { BrowserRouter } from "react-router-dom";
import {
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  useDraftSessionIds,
} from "../../src/lib/clientSummaryStore";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n";
import { CurrentSourceRuntimeProvider } from "../../src/contexts/SourceRuntimeContext";
import { useDraftPersistence } from "../../src/hooks/useDraftPersistence";
import "../../src/styles/purposeGlobals";

const sessionId = new URLSearchParams(window.location.search).get("session");
const draftKey = sessionId
  ? `draft-message-${sessionId}`
  : "draft-new-session:local";
const sessionDraft = sessionId
  ? { sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY, sessionId }
  : undefined;

function SessionNavigation() {
  const draftSessionIds = useDraftSessionIds();
  return sessionId ? (
    <nav aria-label="Sessions">
      <SidebarNavItem
        to={`${window.location.pathname}${window.location.search}`}
        icon={SidebarIcons.projects}
        label="Synced session"
        hasDraft={draftSessionIds.has(sessionId)}
      />
    </nav>
  ) : null;
}

function Activity() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 40);
    return () => clearInterval(timer);
  }, []);
  return (
    <section aria-label="Session activity">
      <p>Session activity {tick}</p>
      {Array.from({ length: 1000 }, (_, i) => (
        <div key={i}>
          Session {i}: {i === tick % 1000 ? "working" : "ready"}
        </div>
      ))}
    </section>
  );
}
function Composer() {
  const [value, setValue, controls] = useDraftPersistence(draftKey, {
    sessionDraft,
  });
  return (
    <>
      <DraftSyncNotice draftKey={draftKey} />
      <label htmlFor="prompt">Prompt</label>
      <textarea
        id="prompt"
        data-draft-key={draftKey}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        style={{ width: "100%", height: 180, margin: "12px 0" }}
      />
      <button
        type="button"
        style={{ minHeight: 44 }}
        onClick={() => {
          controls.clearInput();
          setTimeout(() => controls.confirmInputClear(), 100);
        }}
      >
        Send
      </button>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <BrowserRouter>
      <CurrentSourceRuntimeProvider>
        <main
          style={{ maxWidth: 820, margin: "96px auto 20px", padding: "0 16px" }}
        >
          <h1>{sessionId ? "Session draft" : "New session"}</h1>
          <SessionNavigation />
          <p>Your draft stays on this device and syncs when connected.</p>
          <Composer />
          <Activity />
        </main>
      </CurrentSourceRuntimeProvider>
    </BrowserRouter>
  </I18nProvider>,
);
