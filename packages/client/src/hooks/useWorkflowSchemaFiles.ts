import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import type { WorkflowSchemaFiles } from "@yep-anywhere/shared/transcript/workflowTags";
import { WorkflowSchemaFileStore } from "../lib/workflowSchemaFiles";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";

const EMPTY: WorkflowSchemaFiles = {};
const emptySnapshot = () => EMPTY;
const emptySubscribe = () => () => {};

export function useWorkflowSchemaFiles(enabled: boolean) {
  const metadata = useOptionalSessionMetadata();
  const runtime = useCurrentSourceRuntime();
  const projectId = metadata?.projectId;
  const sessionId = metadata?.sessionId;
  const store = useMemo(() => {
    if (!enabled || !projectId || !sessionId) return null;
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      // Rendering remains available when browser persistence is disabled.
    }
    return new WorkflowSchemaFileStore(
      (path, init) =>
        runtime.transport.fetchResponse(
          `/projects/${projectId}/files/raw?${new URLSearchParams({ path })}`,
          init,
        ),
      `ya:workflow-schema-files:v1:${JSON.stringify([runtime.sourceKey, projectId, sessionId])}`,
      storage,
    );
  }, [enabled, projectId, sessionId, runtime]);
  useEffect(() => () => store?.dispose(), [store]);
  const references = useRef(new Set<string>());
  useEffect(() => {
    if (!store) return;
    const refresh = () => {
      if (
        document.visibilityState === "visible" &&
        runtime.transport.status.getSnapshot().state === "ready"
      )
        store.request(references.current);
    };
    document.addEventListener("visibilitychange", refresh);
    const unsubscribe = runtime.transport.status.subscribe(refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      unsubscribe();
    };
  }, [store, runtime]);
  const files = useSyncExternalStore(
    store?.subscribe ?? emptySubscribe,
    store?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  const resolve = useCallback(
    (items: readonly RenderItem[]) => {
      if (!store) return;
      const nextReferences = new Set<string>();
      for (const item of items)
        for (const marker of item.workflow?.markers ?? [])
          if (marker.schemaRef) nextReferences.add(marker.schemaRef);
      references.current = nextReferences;
      if (document.visibilityState === "visible") store.request(nextReferences);
    },
    [store],
  );
  return { files, resolve };
}
