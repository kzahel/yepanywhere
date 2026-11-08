import { type ReactNode, useRef } from "react";
import {
  SessionManagedPanel,
  useSessionViewerSessionId,
} from "./SessionManagedViewer";
import { Modal } from "./ui/Modal";
import { ViewerSelectAllButton } from "./ViewerSelectAllButton";

interface ActivityDetailModalProps {
  title: ReactNode;
  actions?: ReactNode;
  label: string;
  briefLabel?: string;
  children: ReactNode;
  onClose: () => void;
}

/**
 * Publishes an activity detail view to the stable session-level host. Outside
 * the explicit session-viewer provider it remains a plain close-only modal.
 */
export function ActivityDetailModal({
  title,
  actions,
  label,
  briefLabel,
  children,
  onClose,
}: ActivityDetailModalProps) {
  const sessionId = useSessionViewerSessionId();
  const contentRef = useRef<HTMLDivElement>(null);
  const headerActions = (
    <>
      {actions}
      <ViewerSelectAllButton contentRef={contentRef} />
    </>
  );
  const managedPanelRef = useRef<{
    sessionId: string;
    title: ReactNode;
    actions: ReactNode;
    label: string;
    briefLabel?: string;
    children: ReactNode;
  } | null>(null);

  // The source row can rerender for every transcript update and selection
  // event. Keep the opened detail's React nodes fixed so those unrelated
  // renders cannot replace the browser's live selection boundaries.
  if (
    sessionId &&
    (!managedPanelRef.current ||
      managedPanelRef.current.sessionId !== sessionId)
  ) {
    managedPanelRef.current = {
      sessionId,
      title,
      actions: headerActions,
      label,
      briefLabel,
      children,
    };
  }

  if (!sessionId) {
    return (
      <Modal
        title={title}
        actions={headerActions}
        contentRef={contentRef}
        onClose={onClose}
      >
        {children}
      </Modal>
    );
  }

  const managedPanel = managedPanelRef.current;
  if (!managedPanel) return null;

  return (
    <SessionManagedPanel
      sessionId={managedPanel.sessionId}
      title={managedPanel.title}
      actions={managedPanel.actions}
      contentRef={contentRef}
      label={managedPanel.label}
      briefLabel={managedPanel.briefLabel}
      onClose={onClose}
    >
      {managedPanel.children}
    </SessionManagedPanel>
  );
}
