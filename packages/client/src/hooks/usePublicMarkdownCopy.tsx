import { useCallback, useEffect, useRef, useState } from "react";
import {
  SERVER_CAPABILITIES,
  serverHasCapability,
  type ProjectAppInfo,
  type ProjectFileLinks,
} from "@yep-anywhere/shared";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { usePublicShareContext } from "../contexts/PublicShareContext";
import { useOptionalToastContext } from "../contexts/ToastContext";
import { useRetainedVersionInfo } from "./useVersion";
import { useI18n } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";
import {
  preparePublicMarkdownCopy,
  renderPublicMarkdownCopy,
  type PublicMarkdownCopy,
} from "../lib/publicMarkdownCopy";
import { PublicMarkdownShareDialog } from "../components/PublicMarkdownShareDialog";
import type { SelectionActionSnapshot } from "./useSelectionActionCapture";

/** Load link metadata at selection time; copying never awaits a service request. */
export function usePublicMarkdownCopy(
  snapshot: SelectionActionSnapshot | null,
) {
  const runtime = useCurrentSourceRuntime();
  const version = useRetainedVersionInfo(runtime.sourceKey);
  const publicShare = usePublicShareContext();
  const toast = useOptionalToastContext();
  const { t } = useI18n();
  const [share, setShare] = useState<{
    copy: PublicMarkdownCopy;
    apps: Map<string, ProjectFileLinks>;
    sourceKey: string;
  } | null>(null);
  const metadata = useRef<{
    runtime: typeof runtime;
    info: Map<string, ProjectAppInfo | null>;
    pending: Map<string, Promise<ProjectAppInfo | null>>;
  }>({ runtime, info: new Map(), pending: new Map() });
  const mounted = useRef(true);
  const starts = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const supported =
    publicShare === null &&
    serverHasCapability(version, SERVER_CAPABILITIES.projectService.name);
  const prepare = useCallback(
    (selected: SelectionActionSnapshot) =>
      preparePublicMarkdownCopy(
        selected.snippets,
        [...runtime.summary.getSnapshot().projects.entities.values()],
        window.location.href,
      ),
    [runtime],
  );
  useEffect(() => {
    if (!snapshot || !supported) {
      metadata.current = { runtime, info: new Map(), pending: new Map() };
      return;
    }
    if (metadata.current.runtime !== runtime)
      metadata.current = { runtime, info: new Map(), pending: new Map() };
    const cache = metadata.current;
    const copy = preparePublicMarkdownCopy(
      snapshot.snippets,
      [...runtime.summary.getSnapshot().projects.entities.values()],
      window.location.href,
    );
    for (const { file } of copy.references) {
      if (cache.info.has(file.projectId) || cache.info.size >= 32) continue;
      cache.info.set(file.projectId, null);
      const pending = runtime.transport
        .fetch<ProjectAppInfo>(
          `/projects/${encodeURIComponent(file.projectId)}/app`,
          { signal: AbortSignal.timeout(5000) },
        )
        .then(
          (info) => {
            cache.info.set(file.projectId, info);
            return info;
          },
          () => {
            cache.info.set(file.projectId, null);
            return null;
          },
        );
      cache.pending.set(file.projectId, pending);
    }
  }, [runtime, snapshot, supported]);

  const copyPublic = useCallback(
    (selected: SelectionActionSnapshot) => {
      const copy = prepare(selected);
      const apps = new Map<string, ProjectFileLinks>();
      const infos =
        metadata.current.runtime === runtime
          ? metadata.current.info
          : new Map<string, ProjectAppInfo | null>();
      if (supported)
        for (const [id, info] of infos)
          if (info?.fileLinks) apps.set(id, info.fileLinks);
      const result = renderPublicMarkdownCopy(copy, apps);
      const copied = writeClipboardText(result.markdown);
      void copied.then((ok) => {
        if (!mounted.current || metadata.current.runtime !== runtime) return;
        const mayCreate =
          publicShare === null &&
          serverHasCapability(
            version,
            SERVER_CAPABILITIES.publicFileShares.name,
          );
        toast?.showToast(
          t(ok ? "publicMarkdownCopied" : "publicMarkdownCopyFailed", {
            count: result.unresolved.length,
          }),
          ok ? "info" : "error",
          ok && result.unresolved.length && mayCreate
            ? {
                label: t("publicMarkdownCreateLinks"),
                onClick: () =>
                  setShare({ copy, apps, sourceKey: runtime.sourceKey }),
              }
            : undefined,
        );
      });
      // Metadata and listener checks may finish after copying, never rewriting it.
      const cache = metadata.current;
      for (const projectId of new Set(
        copy.references.map(({ file }) => file.projectId),
      )) {
        const startKey = `${runtime.sourceKey}:${projectId}`;
        if (
          !supported ||
          cache.runtime !== runtime ||
          starts.current.has(startKey)
        )
          continue;
        starts.current.add(startKey);
        void (async () => {
          const info =
            infos.get(projectId) ?? (await cache.pending.get(projectId));
          if (
            !mounted.current ||
            metadata.current.runtime !== runtime ||
            !info?.fileLinks ||
            info.declaration?.where.kind !== "process" ||
            !(info.canStart ?? info.canExecute) ||
            info.mode === "live-preview"
          )
            return;
          await runtime.transport.fetch(
            `/projects/${encodeURIComponent(projectId)}/app/start`,
            {
              method: "POST",
              body: JSON.stringify({ mode: "app" }),
              signal: AbortSignal.timeout(125_000),
            },
          );
        })()
          .catch(() => {
            if (mounted.current && metadata.current.runtime === runtime)
              toast?.showToast(t("publicMarkdownStartFailed"), "error");
          })
          .finally(() => starts.current.delete(startKey));
      }
    },
    [prepare, publicShare, runtime, supported, t, toast, version],
  );
  const available = useCallback(
    (selected: SelectionActionSnapshot) =>
      publicShare === null && prepare(selected).references.length > 0,
    [prepare, publicShare],
  );
  return {
    available,
    copyPublic,
    shareDialog:
      share?.sourceKey === runtime.sourceKey ? (
        <PublicMarkdownShareDialog
          copy={share.copy}
          apps={share.apps}
          onClose={() => setShare(null)}
        />
      ) : null,
  };
}
