import { isRecord } from "./plain-record.js";

/**
 * Sandbox for every frame on the isolated artifact origin and for the artifact
 * response's own CSP `sandbox` directive. It grants no popups or top-level
 * navigation: an unsandboxed popup would hold `opener.top`, the YA tab, and
 * could navigate it. A document the frame cannot show is handed to a new tab
 * through the viewer instead (`ARTIFACT_TAB_PROTOCOL`). Downloads are allowed
 * because artifact HTML is the operator's own and may save files it builds,
 * such as a Blob behind an `<a download>`.
 */
export const ARTIFACT_SANDBOX =
  "allow-scripts allow-same-origin allow-downloads";

/**
 * Sandbox for a running project or session app's frame. Beyond
 * `ARTIFACT_SANDBOX` it allows forms and popups that escape the sandbox: the
 * app is the operator's own and is meant to work in the pane as in a tab,
 * including "open in a new tab" links, at the cost that such a popup could
 * navigate the YA tab through its opener.
 */
export const SERVED_APP_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox";

/**
 * Permissions delegated to a running app's frame through its `allow`
 * attribute, so an app that records audio can do so inside the pane. The
 * app's own `Permissions-Policy` still decides whether it may use them.
 */
export const SERVED_APP_FRAME_ALLOW = "microphone";

/**
 * A framed artifact page asks the YA viewer to open one URL of its own grant in
 * a new tab, for a document such as a PDF that a sandboxed frame cannot
 * display. The viewer accepts it only from its own frame and opens it without
 * an opener.
 */
export const ARTIFACT_TAB_PROTOCOL = "yep-artifact-tab/1";

export interface ArtifactTabRequest {
  protocol: typeof ARTIFACT_TAB_PROTOCOL;
  type: "open";
  url: string;
}

export function isArtifactTabRequest(
  value: unknown,
): value is ArtifactTabRequest {
  return (
    isRecord(value) &&
    value.protocol === ARTIFACT_TAB_PROTOCOL &&
    value.type === "open" &&
    typeof value.url === "string"
  );
}

export interface ArtifactVhost {
  name: string;
  port: number;
  env?: string;
  public?: boolean;
}

/**
 * A vhost that serves one file or directory itself rather than proxying a
 * loopback port. Its name shares the namespace of port vhosts and reserved
 * project app addresses; the first claim keeps it.
 */
export interface ArtifactVhostSite {
  name: string;
  ownerUsername?: string;
  projectId?: string;
  projectRoot?: string;
  /** Absolute server path of the served file or directory. */
  path: string;
  /** No app link required; with a password, visitors must supply it. */
  public?: boolean;
  /** Reported by the server: a visitor password is set. */
  passwordProtected?: boolean;
  /**
   * Sent by a client only: a new password sets it, an empty string clears
   * it, and absent keeps the saved one.
   */
  password?: string;
}

/** A file site as the authenticated owner sees it, with its addresses. */
export interface ArtifactVhostSiteView extends ArtifactVhostSite {
  kind: "file" | "directory" | "missing";
  /** `https://name.<public root>/`, when a public root is configured. */
  publicUrl?: string;
  /** `http://name.localhost:<port>/`, when local serving is enabled. */
  localUrl?: string;
  /** For a file row: what it serves by following the file's links. */
  linkedFiles?: ArtifactVhostLinkedFiles;
}

/** The files a file row reaches through its links, the file itself included. */
export interface ArtifactVhostLinkedFiles {
  count: number;
  /** The first files found, relative to the served file's folder. */
  paths: string[];
  /** A walk limit stopped before every link was followed. */
  truncated: boolean;
}

export interface ArtifactViewerConfig {
  port: number;
  localOrigin?: string;
  publicOrigin?: string;
  /** Presence in status metadata enables the expiry setting on the client. */
  expiryHours?: number;
  /** Days a new link lives; presence enables the day-unit control. */
  expiryDays?: number;
  /** Presence enables the static vhost table. */
  vhosts?: ArtifactVhost[];
  /** File and directory vhosts; presence enables their rows. */
  vhostSites?: ArtifactVhostSite[];
  /** Optional apex such as graehl.org; empty means name.localhost only. */
  vhostPublicRoot?: string;
  /** Rewrite name.localhost links even outside a public relay session. */
  alwaysRewriteVhostLinks?: boolean;
}

export interface ArtifactViewerStatus extends ArtifactViewerConfig {
  available: boolean;
  locked: boolean;
  defaultLocalOrigin: string;
}

export interface ArtifactViewerGrant {
  id: string;
  url: string;
  expiresAt: number;
  /** True when this grant deletes its directory at expiry or revocation. */
  owned?: boolean;
  /**
   * True when the server handed out an existing live grant that other viewers
   * or tabs may hold, so the requester must not revoke it. Older servers omit
   * it and never reuse.
   */
  reused?: boolean;
}

/** Managed preview grants bound delivered bytes, including repeated media seeks. */
export const MANAGED_ARTIFACT_MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MANAGED_ARTIFACT_MAX_VIEWER_BYTES = 1024 * 1024 * 1024;
export const MANAGED_ARTIFACT_READ_IDLE_MS = 120_000;
