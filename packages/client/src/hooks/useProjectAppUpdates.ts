import { useEffect, useRef, useState } from "react";
import type { ProjectAppInfo } from "@yep-anywhere/shared/project-service";
import { projectAppApi } from "../api/projectApp";

/** `updatedAt` arrives with the server's change stamp; older servers omit it. */
type AppInfo = ProjectAppInfo & { updatedAt?: string };

/**
 * What changing the app means here: a usable declaration appearing, or a
 * newer build. A declared app whose build is missing is not there to show.
 */
function appStamp(info: AppInfo): string | null {
  if (!info.declaration && !info.activeDeclaration)
    return info.direct?.redirect ? `redirect:${info.direct.redirect}` : null;
  if (info.state === "missing" || info.state === "unavailable") return null;
  return info.updatedAt ?? "declared";
}

/**
 * Watches a session's project App across turns: `onUpdated` runs when a turn
 * ends with the app newly declared or rebuilt (topics/project-service.md
 * § Project App and Settings), so the user sees what they asked for without
 * finding the App button. Returns whether the project currently declares an
 * app. A server without `updatedAt` still reports a first declaration.
 *
 * While `open`, a reading without a declaration does not withdraw it: an
 * `app.json` mid-edit or a restarting service can read that way, and dropping
 * it would unmount the open app and take its keyboard focus. A removal takes
 * effect once the app is closed.
 */
export function useProjectAppUpdates(
  projectId: string | undefined,
  enabled: boolean,
  turnActive: boolean,
  open: boolean,
  onUpdated: () => void,
): boolean {
  const [declared, setDeclared] = useState<{ projectId: string } | null>(null);
  // The latest reading's verdict, applied when an open app is closed.
  const [lastReading, setLastReading] = useState<{
    projectId: string;
    declares: boolean;
  } | null>(null);
  const baseline = useRef<{ projectId: string; stamp: string | null } | null>(
    null,
  );
  const callback = useRef(onUpdated);
  callback.current = onUpdated;
  const openRef = useRef(open);
  openRef.current = open;

  // Read at entry and whenever a turn starts or ends: the start reading is
  // the baseline an end reading is compared with.
  useEffect(() => {
    if (!enabled || !projectId) return;
    let active = true;
    void projectAppApi
      .info(projectId)
      .then((info) => {
        if (!active) return;
        const stamp = appStamp(info);
        // A redirect alone is a complete app (§ Direct serving).
        const declares = !!(
          info.declaration ||
          info.activeDeclaration ||
          info.direct?.redirect
        );
        setLastReading({ projectId, declares });
        setDeclared((current) =>
          declares
            ? { projectId }
            : openRef.current && current?.projectId === projectId
              ? current
              : null,
        );
        const before =
          baseline.current?.projectId === projectId ? baseline.current : null;
        if (!turnActive && before && stamp && stamp !== before.stamp)
          callback.current();
        baseline.current = { projectId, stamp };
      })
      // No app is no action; the button simply stays hidden.
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [projectId, enabled, turnActive]);

  // Closing applies a withdrawal that arrived while the app was open.
  useEffect(() => {
    if (open || lastReading?.declares !== false) return;
    if (lastReading.projectId === projectId) setDeclared(null);
  }, [open, lastReading, projectId]);

  return enabled && declared?.projectId === projectId;
}
