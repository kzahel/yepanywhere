import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../../src/i18n";
import { SchemaValidationProvider } from "../../src/contexts/SchemaValidationContext";
import { SessionMetadataProvider } from "../../src/contexts/SessionMetadataContext";
import { ToastProvider } from "../../src/contexts/ToastContext";
import { MessageList } from "../../src/components/MessageList";
import { MessageInput } from "../../src/components/MessageInput";
import type { Message } from "../../src/types";
import sessionStyles from "../../src/pages/SessionPage.module.css";
import { projectId, sessionId } from "./fixture";

export function mountTranscript(
  read: () => Message[],
  subscribe: (listener: () => void) => () => void,
) {
  function Transcript() {
    const messages = useSyncExternalStore(subscribe, read);
    return (
      <section
        style={{ height: "100dvh", display: "flex", flexDirection: "column" }}
      >
        <div
          className={sessionStyles["session-messages"]}
          data-session-messages
        >
          <MessageList
            messages={messages}
            provider="claude"
            conversationViewEnabledOverride={false}
          />
        </div>
        <MessageInput draftKey="frontend-probe-draft" onSend={() => {}} />
      </section>
    );
  }
  createRoot(document.getElementById("root")!).render(
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          <SchemaValidationProvider>
            <SessionMetadataProvider
              projectId={projectId}
              projectPath="/synthetic/frontend"
              sessionId={sessionId}
              provider="claude"
            >
              <Transcript />
            </SessionMetadataProvider>
          </SchemaValidationProvider>
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}
