import type { ReactNode, RefObject } from "react";
import { useSyncExternalStore } from "react";
import type { MessageKey } from "../i18n";
import { sessionViewerUsesRightPane } from "./sessionViewerPlacement";

/**
 * What the viewer toolbar's trailing button does, whatever the viewer is.
 *
 * A viewer that dismisses itself gets the default below; one whose dismissal
 * costs something — stopping an app, say — installs its own descriptor with
 * `setSessionViewerCloseAction`. Readers render this and never ask what kind
 * of viewer they are showing.
 */
export interface SessionViewerCloseAction {
  label: MessageKey;
  destructive?: boolean;
  busy?: boolean;
  run: () => void;
}

interface SessionViewerBase {
  id: string;
  sessionId: string;
  label: string;
  briefLabel?: string;
  closeAction?: SessionViewerCloseAction;
  /** Set when the session's own output opened it; absent means a user gesture. */
  openedBy?: "session";
}

export interface PanelViewerRegistration extends SessionViewerBase {
  kind: "panel";
  onClose: () => void;
  title: ReactNode;
  actions?: ReactNode;
  contentRef?: RefObject<HTMLDivElement | null>;
  content: ReactNode;
}

interface FileViewerBase extends SessionViewerBase {
  kind: "file";
  filePath: string;
  lineSuffix: string;
  supportsRightPane?: boolean;
}

export type FileViewerRegistration = FileViewerBase &
  (
    | { onClose: () => void; renderContent?: never }
    | {
        onClose?: () => void;
        renderContent: (inactive: boolean, rightPane?: boolean) => ReactNode;
      }
  );

export type SessionViewerRegistration =
  | PanelViewerRegistration
  | (SessionViewerBase & {
      kind: "vhost";
      url: string;
      /** The loopback URL the agent printed, before vhost rewriting. */
      sourceUrl?: string;
      onClose?: never;
      artifactToken?: string;
    })
  | (SessionViewerBase & { kind: "artifact"; url: string; onClose?: never })
  | FileViewerRegistration;

type ViewerCommands = {
  close: () => void;
  minimize: () => void;
  minimized: boolean;
  restore: () => void;
};

/** Layout and toolbar consumers never observe React content or source handlers. */
export type SessionViewerControllerState = (
  | (SessionViewerBase & { kind: "panel" })
  | FileViewerBase
  | Extract<SessionViewerRegistration, { kind: "artifact" | "vhost" }>
) &
  ViewerCommands;

/** Only the managed host subscribes to the current render payload. */
export type SessionViewerRenderState = SessionViewerRegistration &
  ViewerCommands;

interface ControllerStore {
  current: SessionViewerRenderState | null;
  snapshot: SessionViewerControllerState | null;
  renderSnapshot: SessionViewerRenderState | null;
  listeners: Set<() => void>;
  renderListeners: Set<() => void>;
  resumeRevision: number;
}

// A hot update re-runs this module; carrying the store across keeps the open
// viewer, and the subscribers of the replaced module, in place.
// Vitest provides import.meta.hot without data.
const hotData: { store?: ControllerStore } | undefined = import.meta.hot?.data;
const store: ControllerStore = hotData?.store ?? {
  current: null,
  snapshot: null,
  renderSnapshot: null,
  listeners: new Set(),
  renderListeners: new Set(),
  resumeRevision: 0,
};
if (hotData) hotData.store = store;
// An already-open Vite page may carry the previous store shape through HMR.
store.snapshot ??= null;
store.renderSnapshot ??= store.current;
store.renderListeners ??= new Set();
const listeners = store.listeners;

function emit(): void {
  for (const listener of listeners) listener();
}

export function sessionViewerFreezesTranscript(
  state: SessionViewerControllerState | null,
): boolean {
  return Boolean(
    state &&
      state.kind !== "artifact" &&
      !sessionViewerUsesRightPane(state) &&
      !state.minimized,
  );
}

function frozenTranscriptSessionId(
  state: SessionViewerControllerState | null,
): string | null {
  if (!state || !sessionViewerFreezesTranscript(state)) return null;
  return state.sessionId;
}

function replaceCurrent(next: SessionViewerRenderState | null): void {
  const previousFrozenSessionId = frozenTranscriptSessionId(store.current);
  const nextFrozenSessionId = frozenTranscriptSessionId(next);
  if (
    previousFrozenSessionId &&
    previousFrozenSessionId !== nextFrozenSessionId
  ) {
    store.resumeRevision += 1;
  }
  const nextSnapshot = next ? controllerSnapshot(next, store.snapshot) : null;
  const metadataChanged = store.snapshot !== nextSnapshot;
  const renderChanged =
    metadataChanged || !sameRenderContent(store.renderSnapshot, next);
  // Install every value before notifying either group. Source handlers stay
  // current even when their new allocation changes neither observable snapshot.
  store.current = next;
  store.snapshot = nextSnapshot;
  if (renderChanged) {
    store.renderSnapshot = next;
  }
  if (metadataChanged) emit();
  if (renderChanged) {
    for (const listener of store.renderListeners) listener();
  }
}

export function closeSessionViewer(id: string): void {
  if (store.current?.id !== id) return;
  const onClose = store.current.onClose;
  replaceCurrent(null);
  onClose?.();
}

function setMinimized(id: string, minimized: boolean): void {
  if (store.current?.id !== id || store.current.minimized === minimized) return;
  replaceCurrent({ ...store.current, minimized });
}

export function minimizeSessionViewer(id: string): void {
  setMinimized(id, true);
}

export function restoreSessionViewer(id: string): void {
  setMinimized(id, false);
}

/**
 * A viewer that has said nothing about dismissal simply closes. A vhost is the
 * exception: stopping the app it shows is the owning session's decision, so its
 * button stays absent until that owner installs one.
 */
function defaultCloseAction(
  registration: SessionViewerRegistration,
  close: () => void,
): SessionViewerCloseAction | undefined {
  if (registration.kind === "vhost") return undefined;
  return {
    label:
      registration.kind === "file" ? "fileViewerClose" : "sessionViewerClose",
    run: close,
  };
}

function toController(
  registration: SessionViewerRegistration,
  minimized: boolean,
): SessionViewerRenderState {
  const { id } = registration;
  const previous =
    store.current?.id === id &&
    store.current.kind === registration.kind &&
    store.current.sessionId === registration.sessionId
      ? store.current
      : null;
  const close = previous?.close ?? (() => closeSessionViewer(id));
  return {
    ...registration,
    closeAction:
      registration.closeAction ?? defaultCloseAction(registration, close),
    close,
    minimize: previous?.minimize ?? (() => setMinimized(id, true)),
    minimized,
    restore: previous?.restore ?? (() => setMinimized(id, false)),
  };
}

/** Compare only a small data snapshot, never arbitrary React nodes. */
function sameFields(a: object, b: object): boolean {
  const fields = Object.entries(a);
  const other = b as Record<string, unknown>;
  return (
    fields.length === Object.keys(b).length &&
    fields.every(([key, value]) => Object.is(value, other[key]))
  );
}

function controllerSnapshot(
  next: SessionViewerRenderState,
  previous: SessionViewerControllerState | null,
): SessionViewerControllerState {
  const sameViewer =
    previous?.id === next.id &&
    previous.kind === next.kind &&
    previous.sessionId === next.sessionId;
  const id = next.id;
  let closeAction = next.closeAction;
  if (closeAction) {
    // The button's identity/metadata is observable; its latest implementation
    // is not. Refreshing an inline callback must not wake its publishing parent.
    closeAction = {
      ...closeAction,
      run:
        sameViewer && previous.closeAction
          ? previous.closeAction.run
          : () => {
              if (store.current?.id === id) store.current.closeAction?.run();
            },
    };
    if (sameViewer && sameCloseAction(previous.closeAction, closeAction)) {
      closeAction = previous.closeAction;
    }
  }
  const base = {
    id: next.id,
    sessionId: next.sessionId,
    label: next.label,
    briefLabel: next.briefLabel,
    openedBy: next.openedBy,
    closeAction,
    close: next.close,
    minimize: next.minimize,
    restore: next.restore,
    minimized: next.minimized,
  };
  const metadata: SessionViewerControllerState =
    next.kind === "file"
      ? {
          ...base,
          kind: next.kind,
          filePath: next.filePath,
          lineSuffix: next.lineSuffix,
          supportsRightPane: next.supportsRightPane,
        }
      : next.kind === "vhost"
        ? {
            ...base,
            kind: next.kind,
            url: next.url,
            sourceUrl: next.sourceUrl,
            artifactToken: next.artifactToken,
          }
        : next.kind === "artifact"
          ? { ...base, kind: next.kind, url: next.url }
          : { ...base, kind: next.kind };
  return previous && sameFields(previous, metadata) ? previous : metadata;
}

function sameRenderContent(
  a: SessionViewerRenderState | null,
  b: SessionViewerRenderState | null,
): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "panel" && b.kind === "panel") {
    return (
      a.title === b.title &&
      a.actions === b.actions &&
      a.contentRef === b.contentRef &&
      a.content === b.content
    );
  }
  if (a.kind === "file" && b.kind === "file") {
    return a.renderContent === b.renderContent;
  }
  return true;
}

/**
 * Present or update the session's one managed viewer.
 *
 * Replacing a different viewer dismisses its source while an update to the
 * same viewer preserves its parked/open state and mounted host identity.
 */
export function presentSessionViewer(
  registration: SessionViewerRegistration,
): void {
  const previous = store.current;
  const minimized = previous?.id === registration.id && previous.minimized;
  replaceCurrent(toController(registration, Boolean(minimized)));
  if (previous && previous.id !== registration.id) previous.onClose?.();
}

export function clearSessionViewer(id: string): void {
  if (store.current?.id !== id) return;
  replaceCurrent(null);
}

function sameCloseAction(
  a: SessionViewerCloseAction | undefined,
  b: SessionViewerCloseAction | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.run === b.run &&
    a.label === b.label &&
    !!a.destructive === !!b.destructive &&
    !!a.busy === !!b.busy
  );
}

/**
 * Install the open viewer's dismissal descriptor.
 *
 * Owners rebuild the descriptor on every render, so an unchanged one must not
 * publish: field equality is what keeps a caller's effect from re-entering the
 * store it just changed.
 */
export function setSessionViewerCloseAction(
  id: string,
  closeAction: SessionViewerCloseAction | undefined,
): void {
  if (store.current?.id !== id) return;
  if (sameCloseAction(store.current.closeAction, closeAction)) return;
  replaceCurrent({ ...store.current, closeAction });
}

export function clearCurrentSessionViewer(): void {
  if (!store.current) return;
  replaceCurrent(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): SessionViewerControllerState | null {
  return store.snapshot;
}

// Initialize the metadata projection after a hot update without publishing.
if (store.current && !store.snapshot) {
  store.snapshot = controllerSnapshot(store.current, null);
}

export {
  getSnapshot as getSessionViewerSnapshot,
  subscribe as subscribeSessionViewer,
};

export function useSessionViewerController(): SessionViewerControllerState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function subscribeRender(listener: () => void): () => void {
  store.renderListeners.add(listener);
  return () => store.renderListeners.delete(listener);
}

function getRenderSnapshot(): SessionViewerRenderState | null {
  return store.renderSnapshot;
}

export function useSessionViewerRenderState(): SessionViewerRenderState | null {
  return useSyncExternalStore(
    subscribeRender,
    getRenderSnapshot,
    getRenderSnapshot,
  );
}

export function isSessionViewerTranscriptFrozen(
  sessionId: string | null,
): boolean {
  return (
    sessionId !== null && frozenTranscriptSessionId(store.current) === sessionId
  );
}

/**
 * Notify transcript work only when a covering modal stops freezing it.
 * Opening that modal deliberately leaves the covered transcript unchanged.
 */
export function useSessionViewerResumeRevision(): number {
  return useSyncExternalStore(
    subscribe,
    () => store.resumeRevision,
    () => store.resumeRevision,
  );
}
