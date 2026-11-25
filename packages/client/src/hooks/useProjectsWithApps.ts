import type { ProjectAppInfo } from "@yep-anywhere/shared/project-service";
import { useEffect, useState } from "react";
import { projectAppApi } from "../api/projectApp";

const CONCURRENCY = 4;

/** Whether the project App view has anything to open: an app or an artifact. */
function hasApp(info: ProjectAppInfo): boolean {
  return !!(info.declaration || info.activeDeclaration || info.latestArtifact);
}

/**
 * Which of `projectIds` have an App or artifact to open, so the Projects list
 * offers the App button only where the App view would show something. A
 * failed reading leaves the button hidden.
 */
export function useProjectsWithApps(
  projectIds: readonly string[],
  enabled: boolean,
): ReadonlySet<string> {
  const [withApps, setWithApps] = useState<ReadonlySet<string>>(new Set());
  const key = enabled ? projectIds.join("\n") : "";

  useEffect(() => {
    if (!key) return;
    const ids = key.split("\n");
    let active = true;
    let next = 0;
    const worker = async () => {
      while (active && next < ids.length) {
        const id = ids[next++] as string;
        const found = await projectAppApi
          .info(id)
          .then(hasApp)
          .catch(() => false);
        if (!active) return;
        setWithApps((current) => {
          if (current.has(id) === found) return current;
          const updated = new Set(current);
          if (found) updated.add(id);
          else updated.delete(id);
          return updated;
        });
      }
    };
    for (let i = 0; i < Math.min(CONCURRENCY, ids.length); i++) void worker();
    return () => {
      active = false;
    };
  }, [key]);

  return withApps;
}
