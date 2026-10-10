export interface VhostOauthProvider {
  kind: "entra" | "oidc";
  tenantId: string;
  issuer: string;
  clientId: string;
  callbackUrl: string;
  /** Only trust a tunnel header when the actual TCP peer is loopback. */
  visitorIp: "peer" | "cloudflare" | "x-real-ip";
}

export interface VhostOauthStatus {
  /** Environment configuration is authoritative and cannot be edited by API. */
  locked: boolean;
  provider: VhostOauthProvider;
  secretConfigured: boolean;
  /** Identification hint only; short secrets expose no characters. */
  secretSuffix?: string;
  configured: boolean;
  /** Absent on servers predating the independent enable switch. */
  enabled?: boolean;
  /** Present when independently managed sign-in providers are supported. */
  providers?: VhostOauthProviderEntry[];
  policies: Record<string, string[]>;
  accessedHosts: string[];
}

export interface VhostOauthProviderEntry {
  id: string;
  enabled: boolean;
  locked: boolean;
  provider: VhostOauthProvider;
  secretConfigured: boolean;
  secretSuffix?: string;
}

export function vhostOauthProviderName(provider: VhostOauthProvider): string {
  if (provider.kind === "entra") return "Microsoft";
  if (provider.issuer === "https://accounts.google.com") return "Google";
  return provider.issuer ? new URL(provider.issuer).hostname : "OpenID Connect";
}

export interface VhostOauthLogEntry {
  timestamp: string;
  host: string;
  email?: string;
  outcome: "allowed" | "denied" | "error";
  ip?: string;
  ipSource?: "peer" | "cloudflare" | "x-real-ip";
}

/** Host names such as constructor must not inherit a phantom policy. */
export function vhostOauthPolicy(
  policies: Record<string, string[]> | undefined,
  name: string,
): string[] | undefined {
  return policies && Object.hasOwn(policies, name) ? policies[name] : undefined;
}

/** Email globs are case insensitive; only an asterisk is a wildcard. */
export function vhostEmailMatches(email: string, pattern: string): boolean {
  const value = email.toLowerCase();
  const glob = pattern.toLowerCase();
  let i = 0;
  let j = 0;
  let star = -1;
  let retry = 0;
  while (i < value.length) {
    if (glob[j] === "*") {
      star = j++;
      retry = i;
    } else if (glob[j] === value[i]) {
      i++;
      j++;
    } else if (star >= 0) {
      j = star + 1;
      i = ++retry;
    } else return false;
  }
  while (glob[j] === "*") j++;
  return j === glob.length;
}

/** Identify simple containing rows, without attempting general glob algebra. */
export function redundantVhostEmail(
  patterns: readonly string[],
  index: number,
): string | undefined {
  const value = patterns[index]?.trim().toLowerCase();
  if (!value) return;
  const parts = value.split("@");
  if (parts.length !== 2) return;
  return patterns.find((other, i) => {
    if (i === index) return false;
    const normalized = other.trim().toLowerCase();
    if (normalized === value) return i < index;
    const covering = normalized.split("@");
    return (
      covering.length === 2 &&
      covering.every(
        (part, side) =>
          part === "*" || (!part.includes("*") && part === parts[side]),
      )
    );
  });
}
