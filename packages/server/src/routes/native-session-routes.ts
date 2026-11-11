import {
  NATIVE_SESSION_FAMILIES,
  type NativeSessionId,
  isUrlProjectId,
  isYaSessionId,
  parseNativeSessionId,
} from "@yep-anywhere/shared";
import type { Hono } from "hono";
import { principalFor } from "../auth/limitedLaunchPolicy.js";
import { creationStatusForSession } from "../sessions/session-creation-view.js";
import type { SessionsDeps } from "./sessions.js";

type NativeSessionRoutesDeps = Pick<
  SessionsDeps,
  "sessionMetadataService" | "signal" | "scanner" | "readerFactory"
>;

/** Routes that map between YA sessions and their provider-native sources. */
export function registerNativeSessionRoutes(
  routes: Hono,
  deps: NativeSessionRoutesDeps,
): void {
  const isDeleted = (sessionId: string) =>
    creationStatusForSession(
      deps.sessionMetadataService,
      sessionId,
      deps.signal,
    )?.state === "deleted";

  // Resolve a `/sessions/<family>/<native id>` viewer path to its YA session
  // (topics/session-identity.md § Immediate startup and native-facing viewer
  // URLs). The project in the path picks between stores that share a native
  // id; a session shown under another project still resolves when it is the
  // only match, and the detail route then redirects as for any stale link.
  routes.get("/projects/:projectId/native-sessions/:family/:nativeId", (c) => {
    const projectId = c.req.param("projectId");
    const family = NATIVE_SESSION_FAMILIES.find(
      (name) => name === c.req.param("family"),
    );
    let nativeId: NativeSessionId;
    try {
      nativeId = parseNativeSessionId(c.req.param("nativeId"));
    } catch {
      return c.json({ error: "Invalid native session path" }, 400);
    }
    if (!isUrlProjectId(projectId) || !family)
      return c.json({ error: "Invalid native session path" }, 400);
    const identities = deps.sessionMetadataService?.identities;
    if (!identities) return c.json({ error: "Session not found" }, 404);
    const live = identities
      .lookupViewerNative(family, nativeId)
      .filter((identity) => !isDeleted(identity.sessionId));
    const inProject = live.filter(
      (identity) =>
        identity.projectId === projectId ||
        deps.sessionMetadataService?.getMetadata(identity.sessionId)
          ?.workingProjectId === projectId,
    );
    const matches = inProject.length ? inProject : live;
    if (!matches.length) return c.json({ error: "Session not found" }, 404);
    if (matches.length > 1)
      return c.json(
        { error: "Several sessions share this native id; open it by YA id" },
        409,
      );
    return c.json({ sessionId: matches[0]!.sessionId });
  });

  routes.get("/sessions/:sessionId/native-source", async (c) => {
    if (principalFor(c).kind !== "superuser")
      return c.json({ error: "Operator access required" }, 403);
    const sessionId = c.req.param("sessionId");
    if (!isYaSessionId(sessionId))
      return c.json({ error: "Invalid session ID" }, 400);
    const identity =
      deps.sessionMetadataService?.identities?.resolveYa(sessionId);
    if (!identity || isDeleted(sessionId))
      return c.json({ error: "Session not found" }, 404);
    const result = {
      sessionId: identity.sessionId,
      provider: identity.provider,
      projectId: identity.projectId,
      native: identity.native,
      transcriptPath: null as string | null,
    };
    if (!identity.native) return c.json({ ...result, status: "unbound" });
    const project = await deps.scanner.getOrCreateProject(identity.projectId);
    if (!project) return c.json({ ...result, status: "missing" });
    const reader = deps.readerFactory(
      { ...project, provider: identity.provider },
      identity.native,
    );
    if (!reader.getSessionFilePath)
      return c.json({ ...result, status: "unsupported" });
    const transcriptPath = await reader.getSessionFilePath(identity.native.id);
    return c.json({
      ...result,
      transcriptPath,
      status: transcriptPath ? "available" : "missing",
    });
  });
}
