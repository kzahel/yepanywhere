/**
 * Host-based security validation (Vite model).
 *
 * One shared hostname allowlist, three distinct checks:
 *
 * | Check       | What              | Where        | Protects Against           |
 * |-------------|-------------------|--------------|----------------------------|
 * | Host header | Host on /api/*    | security.ts  | DNS rebinding              |
 * | WS Origin   | Origin on WS      | ws-relay.ts  | Cross-site WS hijacking    |
 * | CORS        | Origin on HTTP    | security.ts  | Cross-origin data leaks    |
 *
 * Built-in allowed hostnames:
 * - localhost, 127.0.0.1, ::1, [::1], tauri.localhost
 * - Private IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
 * - *.ts.net (Tailscale, including nested subdomains)
 *
 * Plus ALLOWED_HOSTS env var and in-app settings (comma-separated hostnames, or "*" to allow all).
 */

/**
 * Parse ALLOWED_HOSTS env var into a set of hostnames or wildcard (read once at startup).
 */
const ENV_HOSTS: Set<string> | "*" = (() => {
  const raw = process.env.ALLOWED_HOSTS?.trim();
  if (!raw) return new Set<string>();
  if (raw === "*") return "*";
  return new Set(raw.split(",").map((h) => h.trim().toLowerCase()));
})();

/**
 * Mutable state from in-app settings (updated at runtime via updateAllowedHosts).
 * null = not configured (use defaults only).
 */
let settingsHosts: Set<string> | "*" | null = null;

const artifactHosts = new Set<string>();
let vhostHosts = new Set<string>();

export function registerArtifactOrigins(
  origins: readonly (string | undefined)[],
): void {
  for (const origin of origins)
    if (origin) {
      artifactHosts.add(new URL(origin).hostname);
    }
}

export function isArtifactOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  // A navigated artifact may acquire an opaque origin; it must not gain API access.
  if (origin === "null") return artifactHosts.size > 0;
  try {
    return artifactHosts.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function isArtifactHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return artifactHosts.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function setVhostHostnames(hosts: readonly string[]): void {
  vhostHosts = new Set(hosts.map((host) => host.toLowerCase()));
}

export function isVhostHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return vhostHosts.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function isVhostOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return vhostHosts.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Update allowed hosts from in-app settings. Called on startup (from persisted settings)
 * and when the user changes the setting via the UI.
 *
 * @param value - The allowedHosts setting value: "*" for all, comma-separated hostnames, or undefined to clear
 */
export function updateAllowedHosts(value: string | undefined): void {
  settingsHosts = parseAllowedHostsSetting(value);
}

function parseAllowedHostsSetting(
  value: string | undefined,
): Set<string> | "*" | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed === "*") return "*";
  return new Set(
    trimmed
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True when env var or settings is "*" (disables all host/origin checking). */
export function allowAllHosts(): boolean {
  return ENV_HOSTS === "*" || settingsHosts === "*";
}

/**
 * Core check: is this hostname allowed?
 *
 * Matches against built-in patterns, the ALLOWED_HOSTS env var, and in-app settings.
 * Does NOT check for wildcard — callers should check allowAllHosts() first.
 */
export function isAllowedHostname(hostname: string): boolean {
  return hostnameAllowedBy(hostname, settingsHosts);
}

function hostnameAllowedBy(
  hostname: string,
  settings: Set<string> | "*" | null,
): boolean {
  const h = hostname.toLowerCase();
  if (artifactHosts.has(h) || vhostHosts.has(h)) return false;

  // Localhost variants (IPv4 + IPv6)
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]")
    return true;
  if (h === "tauri.localhost") return true;

  // Private IPv4 ranges
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;

  // Tailscale (*.ts.net — supports nested subdomains like foo.bar.ts.net)
  if (h.endsWith(".ts.net")) return true;

  // ALLOWED_HOSTS env var entries
  if (ENV_HOSTS !== "*" && ENV_HOSTS.size > 0 && ENV_HOSTS.has(h)) return true;

  // In-app settings entries
  if (settings instanceof Set && settings.has(h)) return true;

  return false;
}

/**
 * Validate a Host header value.
 *
 * Strips the port (handling IPv6 bracket syntax) and checks the hostname.
 * Returns true for allowed hosts, false otherwise.
 */
export function isAllowedHost(host: string | undefined): boolean {
  return hostAllowedBy(host, settingsHosts);
}

/**
 * Whether a Host header would pass if the in-app setting were `value`, so a
 * settings change can tell whether it would refuse its own caller.
 */
export function wouldAllowHost(
  host: string,
  value: string | undefined,
): boolean {
  return hostAllowedBy(host, parseAllowedHostsSetting(value));
}

function hostAllowedBy(
  host: string | undefined,
  settings: Set<string> | "*" | null,
): boolean {
  if (isArtifactHost(host)) return false;
  // No Host header = not a browser request (HTTP/1.1 browsers always send Host).
  // No DNS rebinding risk, so allow. Also allows Hono's app.request() in tests.
  if (!host) return true;
  if (ENV_HOSTS === "*" || settings === "*") return true;

  // Strip port from host header.
  // IPv6 with port: [::1]:3400 → ::1
  // IPv6 without port: [::1] → ::1
  // IPv4 with port: 127.0.0.1:3400 → 127.0.0.1
  // Hostname with port: example.com:3400 → example.com
  let hostname: string;
  if (host.startsWith("[")) {
    // IPv6 bracket syntax
    const closeBracket = host.indexOf("]");
    if (closeBracket === -1) return false; // malformed
    hostname = host.slice(1, closeBracket);
  } else {
    hostname = host.replace(/:\d+$/, "");
  }

  return hostnameAllowedBy(hostname, settings);
}

/**
 * Validate an Origin header value.
 *
 * Extracts hostname from the origin URL and checks it.
 * Returns true for missing/null origins (same-origin or non-browser clients).
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return originAllowedBy(origin, settingsHosts);
}

/** Whether an Origin would pass if the in-app setting were `value`. */
export function wouldAllowOrigin(
  origin: string | undefined,
  value: string | undefined,
): boolean {
  return originAllowedBy(origin, parseAllowedHostsSetting(value));
}

function originAllowedBy(
  origin: string | undefined,
  settings: Set<string> | "*" | null,
): boolean {
  if (isArtifactOrigin(origin)) return false;
  // No origin = same-origin request or non-browser client (allowed).
  // "null" = about:blank, file://, sandboxed iframe, etc. (allowed).
  if (!origin || origin === "null") return true;
  if (ENV_HOSTS === "*" || settings === "*") return true;

  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostnameAllowedBy(hostname, settings);
  } catch {
    // Invalid origin URL
    return false;
  }
}
