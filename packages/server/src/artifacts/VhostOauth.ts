import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import {
  vhostEmailMatches,
  vhostOauthPolicy,
  vhostOauthProviderName,
  type VhostOauthLogEntry,
  type VhostOauthStatus,
  type VhostOauthProvider,
} from "@yep-anywhere/shared";
import {
  isAllowedHostname,
  registerArtifactOrigins,
} from "../middleware/allowed-hosts.js";
import { createAuditLog } from "../security/auditLog.js";
import { enforceOwnerOnlyPathPermissionsStrict } from "../utils/filePermissions.js";
import { writeFileAtomically } from "../utils/writeFileAtomically.js";
import type { ArtifactConfig } from "./config.js";
import type { AppAccessTarget } from "./VhostAccess.js";
import { vhostOauthPage } from "./VhostOauthPage.js";
import {
  VhostOauthProviderClient,
  vhostEmailPatternsSchema,
  vhostOauthProviderSchema,
  vhostOauthEnvironment,
  type VhostOauthIdentity,
} from "./VhostOauthProvider.js";

export const VHOST_OAUTH_SESSION_COOKIE = "__Host-ya-app-session";
export const VHOST_OAUTH_FLOW_COOKIE = "__Host-ya-app-flow";
const AUTH_PATH = "/_ya/oauth/";
const FLOW_MS = 5 * 60_000;
const SESSION_MS = 60 * 60_000;
const LOG_BYTES = 1024 * 1024;
const LOG_FILE = "vhost-oauth-access.jsonl";
const hostLabel = z
  .string()
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const logSchema = z.object({
  timestamp: z.iso.datetime(),
  host: z.string().max(253),
  email: z.email().max(254).optional(),
  outcome: z.enum(["allowed", "denied", "error"]),
  ip: z.string().max(45).optional(),
  ipSource: z.enum(["peer", "cloudflare", "x-real-ip"]).optional(),
});
function identityAllowed(identity: VhostOauthIdentity, patterns: string[]) {
  return patterns.some(
    (pattern) =>
      (identity.domainVerified !== false || pattern === "*@*") &&
      vhostEmailMatches(identity.email, pattern),
  );
}
const stateSchema = z.object({
  enabled: z.boolean().default(true),
  providerEnabled: z.boolean().default(true),
  providers: z
    .array(
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9-]{1,64}$/)
          .refine((id) => id !== "default"),
        enabled: z.boolean(),
        provider: vhostOauthProviderSchema,
        secret: z.string().min(1).max(4096),
      }),
    )
    .max(7)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length)
    .default([]),
  provider: vhostOauthProviderSchema.optional(),
  secret: z.string().max(4096).default(""),
  policies: z
    .record(hostLabel, vhostEmailPatternsSchema)
    .refine((value) => Object.keys(value).length <= 1024)
    .default({}),
  accessedHosts: z.array(z.string().max(253)).max(4096).default([]),
});
type State = z.infer<typeof stateSchema>;
interface Flow {
  expiresAt: number;
  name: string;
  host: string;
  destination: string;
  fingerprint: string;
  browser: string;
  nonce: string;
  verifier: string;
  provider: VhostOauthProviderClient;
}
interface Handoff extends Flow {
  identity?: VhostOauthIdentity;
}
interface Session {
  expiresAt: number;
  host: string;
  fingerprint: string;
  identity: VhostOauthIdentity;
}

const token = () => randomBytes(32).toString("base64url");
const cookie = (name: string, value: string, seconds: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;

function requestCookie(request: Request, name: string): string | undefined {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : undefined;
}

function authResponse(
  message: string,
  status: number,
  location?: string,
): Response {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
      ...(location ? { Location: location } : {}),
    },
  });
}

/** Public vhost OAuth admission; no credential here grants YA operator access. */
export class VhostOauth {
  readonly ready: Promise<void>;
  private state: State = {
    enabled: true,
    providerEnabled: true,
    providers: [],
    secret: "",
    policies: {},
    accessedHosts: [],
  };
  private providers = new Map<string, VhostOauthProviderClient>();
  private writing = Promise.resolve();
  private revision = 0;
  /** At most 256 pending sign-ins and 256 one-minute browser handoffs. */
  private readonly flows = new Map<string, Flow>();
  private readonly handoffs = new Map<string, Handoff>();
  /** At most 2048 one-hour sessions; expired entries are pruned on admission. */
  private readonly sessions = new Map<string, Session>();
  /** Last 500 checks for the Apps view; the journal rotates at one MiB. */
  private recent: VhostOauthLogEntry[] = [];
  private readonly log = createAuditLog<VhostOauthLogEntry>({
    fileName: LOG_FILE,
    maxBytes: LOG_BYTES,
    label: "[vhost-oauth]",
  });
  private startWindow = 0;
  private starts = 0;
  private readonly environment = vhostOauthEnvironment();

  private get providerSettings() {
    return this.environment?.provider ?? this.state.provider;
  }
  private get clientSecret() {
    return this.environment?.secret ?? this.state.secret;
  }

  constructor(
    private readonly directory: string | undefined,
    private readonly config: () => ArtifactConfig,
    private readonly fingerprint: (row: AppAccessTarget) => string,
    private readonly revokeSockets: () => void,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    if (!this.directory) {
      this.setProvider();
      return;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await enforceOwnerOnlyPathPermissionsStrict(this.directory, "directory");
    const file = join(this.directory, "vhost-oauth.json");
    try {
      await enforceOwnerOnlyPathPermissionsStrict(file, "file");
      if ((await stat(file)).size > 1024 * 1024)
        throw new Error("Oversized OAuth state");
      this.state = stateSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Invalid persisted vhost OAuth settings");
    }
    this.setProvider();
    try {
      const path = join(this.directory, "logs", LOG_FILE);
      if ((await stat(path)).size > LOG_BYTES)
        throw new Error("Oversized OAuth log");
      this.recent = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-500)
        .map((line) => logSchema.parse(JSON.parse(line)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Invalid persisted vhost OAuth access log");
    }
  }

  private setProvider(): void {
    this.providers.clear();
    for (const entry of this.providerEntries()) {
      if (!entry.provider) continue;
      this.validateCallback(entry.provider.callbackUrl, this.config());
      registerArtifactOrigins([new URL(entry.provider.callbackUrl).origin]);
      if (entry.enabled && entry.secret)
        this.providers.set(
          entry.id,
          new VhostOauthProviderClient(
            entry.provider,
            entry.secret,
            this.fetcher,
          ),
        );
    }
  }

  private providerEntries() {
    return [
      {
        id: "default",
        enabled: this.state.providerEnabled,
        provider: this.providerSettings,
        secret: this.clientSecret,
      },
      ...this.state.providers,
    ];
  }

  status(): VhostOauthStatus {
    return {
      locked: !!this.environment,
      provider: this.providerSettings ?? {
        kind: "entra",
        tenantId: "common",
        issuer: "",
        clientId: "",
        callbackUrl: this.config().publicOrigin
          ? `${this.config().publicOrigin}/callback`
          : "",
        visitorIp: "peer",
      },
      secretConfigured: !!this.clientSecret,
      ...(this.clientSecret.length >= 12
        ? { secretSuffix: this.clientSecret.slice(-4) }
        : {}),
      configured: this.providers.size > 0,
      enabled: this.state.enabled,
      providers: this.providerEntries().flatMap((entry) =>
        entry.provider
          ? [
              {
                id: entry.id,
                enabled: entry.enabled,
                locked: entry.id === "default" && !!this.environment,
                provider: entry.provider,
                secretConfigured: !!entry.secret,
                ...(entry.secret.length >= 12
                  ? { secretSuffix: entry.secret.slice(-4) }
                  : {}),
              },
            ]
          : [],
      ),
      policies: this.state.policies,
      accessedHosts: this.state.accessedHosts,
    };
  }

  private validateCallback(url: string, config: ArtifactConfig): void {
    const host = new URL(url).hostname;
    if (
      isAllowedHostname(host) ||
      host.endsWith(".localhost") ||
      isIP(host) ||
      [...(config.vhosts ?? []), ...(config.vhostSites ?? [])].some(
        (row) => `${row.name}.${config.vhostPublicRoot}` === host,
      )
    )
      throw new Error(
        "OAuth callback must use a separate public host, not YA's operator or app host",
      );
  }

  validateConfig(config: ArtifactConfig): void {
    for (const entry of this.providerEntries())
      if (entry.provider)
        this.validateCallback(entry.provider.callbackUrl, config);
  }

  logs(host?: string): VhostOauthLogEntry[] {
    return this.recent
      .filter((entry) => !host || entry.host === host)
      .reverse();
  }

  private update(change: (state: State) => State): Promise<void> {
    const operation = this.writing.then(async () => {
      const next = change(this.state);
      if (this.directory) {
        const file = join(this.directory, "vhost-oauth.json");
        await writeFileAtomically(file, JSON.stringify(next), {
          durable: true,
        });
        await enforceOwnerOnlyPathPermissionsStrict(file, "file");
      }
      this.state = next;
    });
    this.writing = operation.catch(() => {});
    return operation;
  }

  async setEnabled(input: unknown): Promise<void> {
    await this.ready;
    const enabled = z.boolean().parse(input);
    await this.update((current) => ({ ...current, enabled }));
    this.invalidate();
  }

  async configure(input: unknown, id = "default"): Promise<void> {
    await this.ready;
    z.string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .parse(id);
    if (id === "default" && this.environment)
      throw new Error(
        "OAuth provider is configured by YEP_VHOST_OAUTH environment variables",
      );
    const parsed = z
      .object({
        provider: vhostOauthProviderSchema,
        secret: z.string().max(4096).optional(),
      })
      .safeParse(input);
    if (!parsed.success)
      throw new Error(
        "Invalid vhost OAuth provider settings; check the tenant, client and HTTPS callback URL",
      );
    const { provider, secret } = parsed.data;
    this.validateCallback(provider.callbackUrl, this.config());
    await this.update((current) => {
      const previous =
        id === "default"
          ? current
          : current.providers.find((entry) => entry.id === id);
      const sameClient =
        previous?.provider?.kind === provider.kind &&
        previous.provider.clientId === provider.clientId &&
        previous.provider.tenantId === provider.tenantId &&
        previous.provider.issuer === provider.issuer;
      const nextSecret = secret || (sameClient ? previous.secret : "");
      if (!nextSecret)
        throw new Error("A client secret is required for this OAuth client");
      if (id === "default") return { ...current, provider, secret: nextSecret };
      if (!previous && current.providers.length >= 7)
        throw new Error("Use up to eight sign-in providers");
      const entry = {
        id,
        provider,
        secret: nextSecret,
        enabled:
          current.providers.find((row) => row.id === id)?.enabled ?? true,
      };
      return {
        ...current,
        providers: previous
          ? current.providers.map((row) => (row.id === id ? entry : row))
          : [...current.providers, entry],
      };
    });
    this.invalidate();
    this.setProvider();
  }

  async setProviderEnabled(id: string, input: unknown): Promise<void> {
    await this.ready;
    const enabled = z.boolean().parse(input);
    await this.update((current) => {
      if (id === "default") return { ...current, providerEnabled: enabled };
      if (!current.providers.some((entry) => entry.id === id))
        throw new Error("Unknown sign-in provider");
      return {
        ...current,
        providers: current.providers.map((entry) =>
          entry.id === id ? { ...entry, enabled } : entry,
        ),
      };
    });
    this.invalidate();
    this.setProvider();
  }

  async removeProvider(id: string): Promise<void> {
    await this.ready;
    if (id === "default")
      throw new Error("Disable the default provider instead");
    await this.update((current) => ({
      ...current,
      providers: current.providers.filter((entry) => entry.id !== id),
    }));
    this.invalidate();
    this.setProvider();
  }

  async setPolicy(name: string, input: unknown): Promise<void> {
    await this.ready;
    if (!this.rows().some((row) => row.name === name))
      throw new Error("Unknown vhost");
    const parsed = vhostEmailPatternsSchema.nullable().safeParse(input);
    if (!parsed.success)
      throw new Error("Use up to 32 email addresses or email globs");
    if (
      parsed.data !== null &&
      vhostOauthPolicy(this.state.policies, name) === undefined &&
      (!this.providers.size ||
        !this.config().vhostPublicRoot ||
        !this.config().publicOrigin)
    )
      throw new Error(
        "Configure OAuth, public serving and the public vhost root first",
      );
    await this.update((current) => {
      const policies = { ...current.policies };
      if (
        !Object.hasOwn(policies, name) &&
        Object.keys(policies).length >= 1024
      )
        throw new Error("Too many OAuth host policies");
      if (parsed.data === null) delete policies[name];
      else policies[name] = parsed.data;
      return { ...current, policies };
    });
    this.invalidate();
  }

  invalidate(): void {
    this.revision++;
    this.flows.clear();
    this.handoffs.clear();
    this.sessions.clear();
    this.revokeSockets();
  }

  async settled(): Promise<void> {
    await this.writing;
  }

  private rows() {
    return [
      ...(this.config().vhosts ?? []),
      ...(this.config().vhostSites ?? []),
    ];
  }

  private prune(): void {
    for (const entries of [this.flows, this.handoffs, this.sessions])
      for (const [key, entry] of entries)
        if (entry.expiresAt <= Date.now()) entries.delete(key);
  }

  /** Handle the shared callback only at the configured public host and path. */
  async callback(request: Request): Promise<Response | undefined> {
    await this.ready;
    const incoming = new URL(request.url);
    const matchesCallback = (settings: VhostOauthProvider) => {
      const callback = new URL(settings.callbackUrl);
      return (
        (request.headers.get("host") ?? incoming.host).toLowerCase() ===
          callback.host && incoming.pathname === callback.pathname
      );
    };
    if (
      !this.providerEntries().some(
        (entry) => entry.provider && matchesCallback(entry.provider),
      )
    )
      return;
    if (!this.state.enabled)
      return authResponse("Hosted sign-in is disabled", 503);
    if (request.method !== "GET")
      return authResponse("Method not allowed", 405);
    const key = incoming.searchParams.get("state") ?? "";
    const flow = this.flows.get(key);
    if (flow && !matchesCallback(flow.provider.settings))
      return authResponse("Incorrect sign-in callback", 400);
    this.flows.delete(key);
    this.prune();
    if (!flow || flow.expiresAt <= Date.now())
      return authResponse(
        "Sign-in expired. Return to the app and try again.",
        400,
      );
    const revision = this.revision;
    let identity: VhostOauthIdentity | undefined;
    try {
      const callback = new URL(flow.provider.settings.callbackUrl);
      callback.search = incoming.search;
      identity = await flow.provider.identity(
        callback,
        key,
        flow.nonce,
        flow.verifier,
      );
    } catch {
      // Provider errors can contain authorization codes and tokens; never log them.
    }
    if (revision !== this.revision || this.handoffs.size >= 256)
      return authResponse(
        "Sign-in settings changed or the server is busy. Try again.",
        503,
      );
    const ticket = token();
    this.handoffs.set(ticket, {
      ...flow,
      identity,
      expiresAt: Date.now() + 60_000,
    });
    return authResponse(
      "Returning to app",
      303,
      `https://${flow.host}${AUTH_PATH}finish?ticket=${ticket}`,
    );
  }

  /** Undefined keeps legacy/local access; a response stops before content dispatch. */
  async admit(
    request: Request,
    row: AppAccessTarget,
    peer?: string,
  ): Promise<{ expiresAt: number } | Response | undefined> {
    await this.ready;
    const url = new URL(request.url);
    const host = new URL(
      `https://${request.headers.get("host") ?? url.host}`,
    ).host.toLowerCase();
    const publicHost = `${row.name}.${this.config().vhostPublicRoot}`;
    const patterns = vhostOauthPolicy(this.state.policies, row.name);
    const publicAuthority = new URL(`https://${host}`);
    if (publicAuthority.hostname !== publicHost || patterns === undefined)
      return;
    if (!this.state.enabled || !this.providers.size)
      return authResponse(
        "Hosted sign-in is unavailable; this app remains protected",
        503,
      );
    if (publicAuthority.host !== publicHost)
      return authResponse("Unexpected app port", 400);
    this.prune();
    const fingerprint = this.fingerprint(row);
    if (url.pathname === `${AUTH_PATH}finish`) {
      if (request.method !== "GET")
        return authResponse("Method not allowed", 405);
      const key = url.searchParams.get("ticket") ?? "";
      const result = this.handoffs.get(key);
      if (
        !result ||
        result.host !== host ||
        result.fingerprint !== fingerprint ||
        requestCookie(request, VHOST_OAUTH_FLOW_COOKIE) !== result.browser
      )
        return authResponse(
          "Sign-in did not start in this browser. Return to the app and try again.",
          400,
        );
      this.handoffs.delete(key);
      const allowed =
        result.identity && identityAllowed(result.identity, patterns);
      const revision = this.revision;
      await this.record({
        timestamp: new Date().toISOString(),
        host,
        ...(result.identity ? { email: result.identity.email } : {}),
        outcome: result.identity ? (allowed ? "allowed" : "denied") : "error",
        ...this.visitorAddress(
          request,
          peer,
          result.provider.settings.visitorIp,
        ),
      });
      if (revision !== this.revision)
        return authResponse("Sign-in settings changed. Try again.", 409);
      if (!allowed || !result.identity)
        return this.signInPage(
          host,
          result.destination,
          result.identity
            ? "This account is not allowed to access this app."
            : "Sign-in could not be verified. Try again or choose another provider.",
          403,
        );
      if (this.sessions.size >= 2048)
        return authResponse(
          "Too many active app sessions. Try again later.",
          503,
        );
      const session = token();
      this.sessions.set(session, {
        expiresAt: Date.now() + SESSION_MS,
        host,
        fingerprint,
        identity: result.identity,
      });
      const response = authResponse(
        "Signed in",
        303,
        `https://${host}${result.destination}`,
      );
      response.headers.append(
        "Set-Cookie",
        cookie(VHOST_OAUTH_SESSION_COOKIE, session, SESSION_MS / 1000),
      );
      response.headers.append(
        "Set-Cookie",
        cookie(VHOST_OAUTH_FLOW_COOKIE, "", 0),
      );
      return response;
    }
    if (url.pathname === `${AUTH_PATH}start`) {
      if (request.method !== "GET")
        return authResponse("Method not allowed", 405);
      const selected = url.searchParams.get("provider");
      const provider = selected
        ? this.providers.get(selected)
        : this.providers.size === 1
          ? this.providers.values().next().value
          : undefined;
      if (selected && !provider)
        return authResponse("Unknown or disabled sign-in provider", 400);
      if (Date.now() - this.startWindow >= 60_000) {
        this.startWindow = Date.now();
        this.starts = 0;
      }
      if (this.flows.size >= 256 || ++this.starts > 60)
        return authResponse(
          "Too many sign-in attempts. Try again in a minute.",
          429,
        );
      const destination = url.searchParams.get("return") ?? "/";
      if (
        !destination.startsWith("/") ||
        destination.startsWith("//") ||
        /[\\\r\n]/.test(destination) ||
        destination.length > 4096 ||
        destination.startsWith(AUTH_PATH)
      )
        return authResponse("Invalid return address", 400);
      if (!provider) return this.signInPage(host, destination);
      const key = token();
      const flow: Flow = {
        expiresAt: Date.now() + FLOW_MS,
        name: row.name,
        host,
        destination,
        fingerprint,
        browser: token(),
        nonce: token(),
        verifier: token(),
        provider,
      };
      this.flows.set(key, flow);
      try {
        const location = await flow.provider.authorizationUrl(
          key,
          flow.nonce,
          flow.verifier,
        );
        if (this.flows.get(key) !== flow)
          return authResponse("Sign-in settings changed. Try again.", 409);
        const response = authResponse("Sign in", 303, location);
        response.headers.append(
          "Set-Cookie",
          cookie(VHOST_OAUTH_FLOW_COOKIE, flow.browser, FLOW_MS / 1000),
        );
        return response;
      } catch {
        this.flows.delete(key);
        return authResponse(
          "The sign-in provider is unavailable. Try again later.",
          503,
        );
      }
    }
    if (url.pathname.startsWith(AUTH_PATH))
      return authResponse("Not found", 404);
    const session = this.sessions.get(
      requestCookie(request, VHOST_OAUTH_SESSION_COOKIE) ?? "",
    );
    if (
      session &&
      session.host === host &&
      session.fingerprint === fingerprint &&
      identityAllowed(session.identity, patterns)
    ) {
      if (
        (!["GET", "HEAD", "OPTIONS"].includes(request.method) ||
          request.headers.has("upgrade")) &&
        request.headers.get("origin") !== `https://${host}`
      )
        return authResponse("Same-origin request required", 403);
      return { expiresAt: session.expiresAt };
    }
    if (request.method !== "GET" || request.headers.has("upgrade"))
      return authResponse("Sign-in required", 401);
    url.searchParams.delete("ya_access");
    return this.signInPage(host, url.pathname + url.search);
  }

  private signInPage(
    host: string,
    destination: string,
    message = "Sign in with an account that has access to this app.",
    status = 401,
  ): Response {
    return vhostOauthPage({
      host,
      title: status === 403 ? "Unable to sign in" : "Sign in to continue",
      message,
      status,
      buttons: [...this.providers].map(([id, provider]) => ({
        label: `Continue with ${vhostOauthProviderName(provider.settings)}`,
        href: `${AUTH_PATH}start?${new URLSearchParams({ provider: id, return: destination })}`,
      })),
    });
  }

  private visitorAddress(
    request: Request,
    peer: string | undefined,
    mode: VhostOauthProvider["visitorIp"],
  ): Pick<VhostOauthLogEntry, "ip" | "ipSource"> {
    const loopback =
      peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    if (loopback && mode !== "peer") {
      const value = request.headers.get(
        mode === "cloudflare" ? "cf-connecting-ip" : "x-real-ip",
      );
      if (value && isIP(value)) return { ip: value, ipSource: mode };
    }
    return peer && isIP(peer) && !loopback
      ? { ip: peer, ipSource: "peer" }
      : {};
  }

  private async record(entry: VhostOauthLogEntry): Promise<void> {
    await this.log.append(this.directory, entry);
    this.recent = [...this.recent.slice(-499), entry];
    if (!this.state.accessedHosts.includes(entry.host))
      await this.update((current) => ({
        ...current,
        accessedHosts: [
          ...current.accessedHosts
            .filter((host) => host !== entry.host)
            .slice(-4095),
          entry.host,
        ],
      }));
  }
}
