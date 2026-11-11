import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MessageInput } from "../../src/components/MessageInput";
import {
  CurrentSourceRuntimeProvider,
  useCurrentSourceRuntime,
} from "../../src/contexts/SourceRuntimeContext";
import { ToastProvider } from "../../src/contexts/ToastContext";
import { I18nProvider } from "../../src/i18n";
import type { DraftControls } from "../../src/hooks/useDraftPersistence";
import {
  draftStorage,
  collectSyncedSubmissionAttachments,
  subscribeDraftStorage,
} from "../../src/lib/draftSyncStorage";
import { readDraftAttachmentStateValue } from "../../src/lib/draftEnvelope";
import { LOCAL_CLIENT_SUMMARY_SOURCE_KEY } from "../../src/lib/clientSummaryStore";
import {
  collectComposerAttachmentsForSubmission,
  materializeComposerAttachmentsForSubmission,
  createComposerDraftAttachmentState,
} from "../../src/lib/sessionComposerSubmission";
import type { ComposerAttachment } from "../../src/lib/sessionComposerAttachments";
import "../../src/styles/purposeGlobals";

const draftKey = "draft-message-draft-history-1";
const previewUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#202734"/><rect x="12" y="12" width="35" height="75" fill="#374458"/><rect x="56" y="12" width="91" height="15" fill="#82a18d"/><path d="M56 40h75M56 55h90M56 70h60" stroke="#a6afb9" stroke-width="5"/></svg>')}`;
function Composer() {
  const { transport } = useCurrentSourceRuntime();
  const [refs, setRefs] = useState<ComposerAttachment[]>([]);
  const [sent, setSent] = useState<ComposerAttachment[]>([]);
  const controlsRef = useRef<DraftControls | null>(null);
  const ready = useCallback((controls: DraftControls) => {
    controlsRef.current = controls;
    setRefs(
      readDraftAttachmentStateValue(draftStorage.getItem(draftKey))?.refs ?? [],
    );
  }, []);
  useEffect(
    () =>
      subscribeDraftStorage(draftKey, () =>
        setRefs(
          readDraftAttachmentStateValue(draftStorage.getItem(draftKey))?.refs ??
            [],
        ),
      ),
    [],
  );
  return (
    <>
      <output data-testid="sent-attachments">
        {sent.map((ref) => ref.id).join(",")}
      </output>
      <MessageInput
        draftKey={draftKey}
        draftIndex={{
          sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
          sessionId: "draft-history-1",
        }}
        onDraftControlsReady={ready}
        onSend={async () => {
          const attachments = await collectComposerAttachmentsForSubmission({
            currentAttachments: refs,
            pendingUploads: [],
            setComposerAttachments: setRefs,
            collectSyncedAttachments: () =>
              collectSyncedSubmissionAttachments(draftKey),
          });
          const files = await materializeComposerAttachmentsForSubmission({
            attachments,
            sourceTransport: transport,
            projectId: "history",
            sessionId: "draft-history-1",
          });
          setSent(files);
          controlsRef.current?.confirmInputClear();
        }}
        onRemoveAttachment={(id) => {
          const remaining = refs.filter((ref) => ref.id !== id);
          controlsRef.current?.setAttachmentState(
            createComposerDraftAttachmentState(remaining),
          );
          setRefs(remaining);
        }}
        isRunning
        attachments={refs.map((ref) => ({ ...ref, previewUrl }))}
      />
    </>
  );
}
function App() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 50);
    return () => clearInterval(timer);
  }, []);
  return (
    <main
      style={{
        height: "100dvh",
        maxWidth: 900,
        margin: "auto",
        display: "flex",
        flexDirection: "column",
        padding: 16,
        boxSizing: "border-box",
      }}
    >
      <h2>rendez attachment flow</h2>
      <p>yepanywhere · Codex</p>
      <section
        style={{ flex: 1, overflow: "auto", minHeight: 0 }}
        aria-label="Live session activity"
      >
        {Array.from({ length: 1000 }, (_, i) => (
          <div key={i}>
            Session activity {i}: {tick === i ? "working" : "ready"}
          </div>
        ))}
      </section>
      <Composer />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <BrowserRouter>
      <ToastProvider>
        <CurrentSourceRuntimeProvider>
          <App />
        </CurrentSourceRuntimeProvider>
      </ToastProvider>
    </BrowserRouter>
  </I18nProvider>,
);
