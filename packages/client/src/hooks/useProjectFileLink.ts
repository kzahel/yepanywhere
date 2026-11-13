import {
  projectFileLink,
  fromUrlProjectId,
  isUrlProjectId,
  SERVER_CAPABILITIES,
  serverHasCapability,
  type ProjectAppInfo,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { usePublicShareContext } from "../contexts/PublicShareContext";
import { useRetainedVersionInfo } from "./useVersion";
import { owningProject } from "../lib/publicMarkdownCopy";
import {
  getProjectRelativePath,
  isAbsoluteLikePath,
  normalizePathSeparators,
} from "../lib/text";

/** Read static link metadata only while a file's copy/share surface is open.
 *
 * An absolute path belongs to the deepest registered project containing it,
 * so a file under another project offers that project's app, not the viewing
 * project's. */
export function useProjectFileLink(
  target: { projectId: string; path: string; rev?: string } | undefined,
): string | null {
  const runtime = useCurrentSourceRuntime();
  const { sourceKey, transport } = runtime;
  const version = useRetainedVersionInfo(sourceKey);
  const publicShare = usePublicShareContext();
  const supported =
    publicShare === null &&
    !target?.rev &&
    serverHasCapability(version, SERVER_CAPABILITIES.projectService.name);
  const file = target && resolveFile(target, runtime);
  const projectId = file?.projectId;
  const [loaded, setLoaded] = useState<{
    projectId: string;
    sourceKey: string;
    links: ProjectAppInfo["fileLinks"];
  } | null>(null);
  useEffect(() => {
    if (!supported || !projectId) return;
    let active = true;
    void transport
      .fetch<ProjectAppInfo>(`/projects/${encodeURIComponent(projectId)}/app`)
      .then(
        (info) => {
          if (active)
            setLoaded({ projectId, sourceKey, links: info.fileLinks });
        },
        () => {
          if (active) setLoaded(null);
        },
      );
    return () => {
      active = false;
    };
  }, [supported, projectId, sourceKey, transport]);
  return supported &&
    file?.path &&
    loaded &&
    loaded.projectId === projectId &&
    loaded.sourceKey === sourceKey &&
    loaded.links
    ? projectFileLink(loaded.links, file.path)
    : null;
}

function resolveFile(
  target: { projectId: string; path: string },
  runtime: ReturnType<typeof useCurrentSourceRuntime>,
): { projectId: string; path: string | null } | null {
  if (!isAbsoluteLikePath(target.path))
    return isUrlProjectId(target.projectId)
      ? {
          projectId: target.projectId,
          path: normalizePathSeparators(target.path).replace(/^\.\//, ""),
        }
      : null;
  const owner =
    owningProject(target.path, [
      ...runtime.summary.getSnapshot().projects.entities.values(),
    ]) ??
    (isUrlProjectId(target.projectId)
      ? { id: target.projectId, path: fromUrlProjectId(target.projectId) }
      : undefined);
  return owner
    ? {
        projectId: owner.id,
        path: getProjectRelativePath(target.path, owner.path),
      }
    : null;
}
