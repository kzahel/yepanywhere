import type { PreviewHost } from "./previewController";
import { getRelayBasePath } from "../remoteRoutePaths";

/** Preserve the selected source when handing back to its full client. */
export function previewFullClientPath(
  host: PreviewHost,
  session?: { projectId: string; id: string },
): string | null {
  const suffix = session
    ? `/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`
    : "";
  if (host.mode === "local") return suffix || "/projects";
  if (host.mode === "relay")
    return host.relayUsername
      ? `${getRelayBasePath(host.relayUsername)}${suffix}`
      : null;
  if (!host.wsUrl) return null;
  try {
    const url = new URL(host.wsUrl);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !/\/api\/ws\/?$/.test(url.pathname)
    )
      return null;
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = `${url.pathname.replace(/\/api\/ws\/?$/, "")}${suffix || "/"}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
