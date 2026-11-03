import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  routerModelSupportsThinking,
  routerModelSupportsServiceTier,
  sanitizeRouterCliModels,
} from "@yep-anywhere/shared";
import type {
  ModelInfo,
  ThinkingConfig,
  EffortLevel,
  ThinkingOption,
  AgentAuthRouterIssueCode,
  AgentAuthRouterOverview,
  AgentAuthRouterPoolInput,
  AgentAuthRouterPoolPolicy,
  AgentAuthRouterRecovery,
  AgentAuthRouterStatus,
} from "@yep-anywhere/shared";
import type {
  SessionMetadata,
  SessionMetadataService,
} from "../metadata/SessionMetadataService.js";
import { mapClaudeCliModels } from "../sdk/providers/claude.js";
import { writeFileAtomically } from "../utils/writeFileAtomically.js";

export interface RouterLaunch {
  models?: ModelInfo[];
  serviceTierSelection?: boolean;
  bindingId: string;
  accountId: string;
  baseUrl: string;
  token: string;
}
interface Connection {
  id: string;
  token: string;
  socketPath: string;
  routerId: string;
  state: "pairing" | "connected" | "revocation-pending" | "disconnected";
}
interface Allocation {
  thinking?: ThinkingOption;
  serviceTier?: string;
  poolId?: string;
  policy?: AgentAuthRouterPoolPolicy;
  requestedAccountId?: string;
  cancelled?: boolean;
  cancellationAcknowledged?: boolean;
  id: string;
  connectionId: string;
  accountId: string;
  provider: "claude" | "codex";
  model: string;
  token: string;
}
interface PrivateState {
  version: 1;
  connection?: Connection;
  allocations: Record<string, Allocation>;
}
interface Info {
  protocol: number;
  routerId: string;
  inferenceOrigin: string;
  capabilities: string[];
  supportedPolicies?: string[];
  policies?: { id: string; label: string }[];
}
export interface RouterAccount {
  displayName?: string;
  directAccountAccess?: boolean;
  id: string;
  provider: "claude" | "codex";
  enabled: boolean;
  renewal: string;
}
export type RouterModel = ModelInfo;

export class RouterUnavailable extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: AgentAuthRouterIssueCode = "operation-rejected",
    /** AAR refused because the account's login expired or was cleared. */
    readonly loginRequired = false,
  ) {
    super(message);
  }
}
/**
 * A refusal from the launch's router step, which precedes any provider
 * start. Creation records it as a known failure, not uncertain delivery.
 */
export class RouterRefusedBeforeProvider extends RouterUnavailable {
  constructor(cause: RouterUnavailable) {
    super(cause.status, cause.message, cause.code, cause.loginRequired);
  }
}
/** The account itself is fine; only its owner can restore its login. */
function routerLoginRequired(accountName?: string): RouterUnavailable {
  return new RouterUnavailable(
    409,
    `The pinned router account${accountName ? ` (${accountName})` : ""} needs to sign in again: its login in AAR expired or was cleared. Sign that account in again in AAR, then retry. This session's pin will not change.`,
    "account-unavailable",
    true,
  );
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const token = (prefix: string) =>
  prefix + randomBytes(32).toString("base64url");
/** AAR's own default control socket, used when the owner names none. */
export function defaultRouterSocket(): string {
  return join(homedir(), ".agent-auth-router", "control.sock");
}

export function validateRouterSocket(socketPath: string): void {
  if (process.platform === "win32")
    throw new RouterUnavailable(
      409,
      "Local router requires macOS or Linux",
      "unsupported",
    );
  for (const [path, socket] of [
    [dirname(socketPath), false],
    [socketPath, true],
  ] as const) {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      throw routerOffline();
    }
    if (
      st.isSymbolicLink() ||
      (socket ? !st.isSocket() : !st.isDirectory()) ||
      st.uid !== process.getuid?.() ||
      st.mode & 0o077
    )
      throw new RouterUnavailable(
        409,
        "Router socket must be private and owned by the YA server user. Fix its ownership and permissions, then retry.",
        "unsafe-socket",
      );
  }
}
function routerOffline() {
  return new RouterUnavailable(
    503,
    "Router unavailable. Start AAR on the YA server and check its socket in Settings → Providers, then retry. This session will keep its pinned account.",
    "unavailable",
  );
}
/**
 * Map each Claude account's CLI rows through the direct list's pipeline, so
 * pool and direct pickers agree. Rows are dropped unless the router
 * advertises them, and are bounded before mapping.
 */
function withCliModels<T>(overview: T, info: Info): T {
  const accounts = (overview as { accounts?: unknown } | null)?.accounts;
  if (!Array.isArray(accounts)) return overview;
  const supported = info.capabilities.includes("catalog-cli-models-v1");
  return {
    ...overview,
    serviceTierSelection: info.capabilities.includes("service-tiers-v1"),
    accounts: accounts.map((account: Record<string, unknown>) => {
      const { cliModels, cliModelsAt, ...rest } = account;
      const rows =
        supported && account.provider === "claude"
          ? sanitizeRouterCliModels(cliModels)
          : undefined;
      if (!rows?.length) return rest;
      return {
        ...rest,
        cliModels: mapClaudeCliModels(rows),
        ...(typeof cliModelsAt === "string" ? { cliModelsAt } : {}),
      };
    }),
  };
}
/**
 * Only 4xx policy refusals are the router's own decisions; 5xx bodies may
 * describe upstream failures and stay generic. Accepted reasons are short
 * plain text, so they cannot carry tokens, paths or markup.
 */
function rejectionReason(
  status: number | undefined,
  body: Buffer,
): string | undefined {
  if (!status || status < 400 || status >= 500) return undefined;
  try {
    const { error } = JSON.parse(body.toString()) as { error?: unknown };
    if (
      typeof error === "string" &&
      /^[A-Za-z][A-Za-z ,;:'()-]{0,159}$/.test(error)
    )
      return error;
  } catch {
    /* Generic message below. */
  }
  return undefined;
}
/** AAR 2026-11 refuses a lapsed or cleared login with a 409 code. */
function rejectedForLogin(status: number | undefined, body: Buffer): boolean {
  if (status !== 409) return false;
  try {
    const { code } = JSON.parse(body.toString()) as { code?: unknown };
    return code === "login_required" || code === "not_enrolled";
  } catch {
    return false;
  }
}
/**
 * Account and pool names are display labels the session keeps after AAR is
 * down or the account is gone, so recovery can name what to re-enable.
 */
function routerLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip them
  const label = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return label ? label.slice(0, 80) : undefined;
}
/** No fetch fallback: control traffic can only use the verified Unix socket. */
export async function routerRequest<T>(
  socketPath: string,
  path: string,
  credential?: string,
  body?: object,
): Promise<T> {
  validateRouterSocket(socketPath);
  return new Promise<T>((resolveResult, reject) => {
    const request = http.request(
      {
        socketPath,
        path,
        method: body ? "POST" : "GET",
        headers: {
          host: "localhost",
          "content-type": "application/json",
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024)
            response.destroy(new Error("oversized response"));
          else chunks.push(chunk);
        });
        response.on("error", () => reject(routerOffline()));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            if (rejectedForLogin(response.statusCode, Buffer.concat(chunks)))
              return reject(routerLoginRequired());
            const reason = rejectionReason(
              response.statusCode,
              Buffer.concat(chunks),
            );
            return reject(
              new RouterUnavailable(
                response.statusCode ?? 503,
                response.statusCode === 401
                  ? "Router connection revoked. Finish disconnecting in Settings → Providers, then reconnect for new sessions. Existing sessions cannot adopt a new pairing."
                  : `Router rejected the operation${reason ? ` (${reason})` : ""}. Check the pinned account and model in Settings → Providers, then retry. No account was substituted.`,
                response.statusCode === 401 ? "revoked" : "operation-rejected",
              ),
            );
          }
          try {
            resolveResult(JSON.parse(Buffer.concat(chunks).toString()) as T);
          } catch {
            reject(
              new RouterUnavailable(
                502,
                "Invalid router response. Check the AAR version and retry.",
                "protocol-mismatch",
              ),
            );
          }
        });
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error("deadline")),
      20_000,
    );
    request.on("close", () => clearTimeout(timer));
    request.on("error", () => reject(routerOffline()));
    request.end(body ? JSON.stringify(body) : undefined);
  });
}
export class AgentAuthRouter {
  private state: PrivateState;
  private readonly directory: string;
  private readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    dataDir: string,
    private readonly metadata?: SessionMetadataService,
  ) {
    this.directory = join(dataDir, "agent-auth-router");
    this.file = join(this.directory, "private.json");
    if (existsSync(this.directory)) {
      const directory = lstatSync(this.directory);
      if (
        !directory.isDirectory() ||
        (process.platform !== "win32" &&
          (directory.mode & 0o077 || directory.uid !== process.getuid?.()))
      )
        throw new Error("Insecure router credential directory");
    }
    if (existsSync(this.file)) {
      const st = lstatSync(this.file);
      if (
        !st.isFile() ||
        (process.platform !== "win32" &&
          (st.mode & 0o077 || st.uid !== process.getuid?.()))
      )
        throw new Error("Insecure router credential store");
      this.state = JSON.parse(readFileSync(this.file, "utf8")) as PrivateState;
      if (
        this.state.version !== 1 ||
        !this.state.allocations ||
        typeof this.state.allocations !== "object"
      )
        throw new Error("Invalid router credential store");
    } else this.state = { version: 1, allocations: {} };
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  private async save(next: PrivateState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const st = lstatSync(this.directory);
    if (
      st.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (st.mode & 0o077 || st.uid !== process.getuid?.()))
    )
      throw new Error("Insecure router credential directory");
    await writeFileAtomically(this.file, JSON.stringify(next), {
      mode: 0o600,
      durable: true,
    });
    this.state = next;
  }
  summary(): AgentAuthRouterStatus {
    const c = this.state.connection;
    return {
      state: c?.state ?? "disconnected",
      routerId: c?.routerId ?? null,
      ...(c && c.state !== "disconnected"
        ? { customSocket: c.socketPath !== defaultRouterSocket() }
        : {}),
    };
  }
  /** An explicit observation; never pairs, revokes, or retries cleanup on read. */
  recovery(): Promise<AgentAuthRouterRecovery> {
    return this.serialize(async () => {
      const c = this.state.connection;
      const snapshot: AgentAuthRouterRecovery = {
        ...this.summary(),
        checkedAt: new Date().toISOString(),
        reachable: null,
        pendingCancellations:
          c?.state !== "disconnected"
            ? Object.values(this.state.allocations).filter(
                (a) =>
                  a.connectionId === c?.id &&
                  a.cancelled &&
                  !a.cancellationAcknowledged,
              ).length
            : 0,
        accounts: [],
      };
      if (!c || c.state === "disconnected") return snapshot;
      try {
        await this.info(c);
        snapshot.reachable = true;
        const result = await routerRequest<{ accounts: RouterAccount[] }>(
          c.socketPath,
          "/v1/accounts",
          c.token,
        );
        snapshot.accounts = result.accounts;
      } catch (error) {
        const issue =
          error instanceof RouterUnavailable ? error : routerOffline();
        snapshot.reachable =
          issue.code === "unavailable" ? false : snapshot.reachable;
        snapshot.issue = { code: issue.code, message: issue.message };
      }
      return snapshot;
    });
  }
  retryCancellations() {
    return this.serialize(async () => {
      const c = this.connection();
      await this.info(c);
      await this.flushCancellations(c);
      return this.summary();
    });
  }
  private connection(): Connection {
    const c = this.state.connection;
    if (c?.state !== "connected")
      throw new RouterUnavailable(
        409,
        c?.state === "revocation-pending"
          ? "Router disconnect is pending. Finish revocation in Settings → Providers. Routed sessions are blocked until it is acknowledged; existing workers may still have access."
          : "Connect the local router in Settings → Providers before launching this session. A session from a disconnected pairing requires a new session; its account pin cannot move.",
      );
    return c;
  }
  private async info(
    c: Pick<Connection, "socketPath" | "routerId">,
  ): Promise<Info> {
    const info = await routerRequest<Info>(c.socketPath, "/v1/info");
    if (c.routerId && info.routerId !== c.routerId)
      throw new RouterUnavailable(
        409,
        "Router identity changed. Restore the original AAR state and socket; this pairing and its sessions cannot move to another router.",
        "identity-mismatch",
      );
    if (info.protocol !== 1 || !info.capabilities?.includes("manual-bindings"))
      throw new RouterUnavailable(
        409,
        "Router protocol mismatch. Run an AAR version supporting local manual bindings (protocol 1), then retry.",
        "protocol-mismatch",
      );
    let origin: URL;
    try {
      origin = new URL(info.inferenceOrigin);
    } catch {
      throw new RouterUnavailable(
        409,
        "Router returned an invalid inference endpoint.",
        "protocol-mismatch",
      );
    }
    if (
      origin.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(origin.hostname) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new RouterUnavailable(
        409,
        "Router inference endpoint must be loopback. Fix the AAR listener and retry.",
        "protocol-mismatch",
      );
    return info;
  }
  connect(socketPath?: string) {
    return this.serialize(async () => {
      const previous = this.state.connection;
      if (previous?.state === "revocation-pending")
        throw new RouterUnavailable(409, "Finish pending disconnect first");
      const keep = previous && previous.state !== "disconnected";
      const path = resolve(
        socketPath ?? (keep ? previous.socketPath : defaultRouterSocket()),
      );
      const info = await this.info({
        socketPath: path,
        routerId: keep ? previous.routerId : "",
      });
      const connection: Connection = keep
        ? { ...previous, socketPath: path }
        : {
            id: randomUUID(),
            token: token("aar_ctl_"),
            socketPath: path,
            routerId: info.routerId,
            state: "pairing",
          };
      await this.save({ ...this.state, connection });
      await routerRequest(path, "/v1/pair", undefined, {
        id: connection.id,
        name: "Yep Anywhere",
        tokenHash: hash(connection.token),
      });
      await this.save({
        ...this.state,
        connection: { ...connection, state: "connected" },
      });
      return this.summary();
    });
  }
  disconnect() {
    return this.serialize(async () => {
      const c = this.state.connection;
      if (!c || c.state === "disconnected") return this.summary();
      await this.save({
        ...this.state,
        connection: { ...c, state: "revocation-pending" },
      });
      await this.info(c);
      try {
        await routerRequest(c.socketPath, "/v1/disconnect", c.token, {});
      } catch (error) {
        if (!(error instanceof RouterUnavailable && error.status === 401))
          throw error;
      }
      await this.save({
        ...this.state,
        connection: { ...c, state: "disconnected" },
      });
      return this.summary();
    });
  }
  async accounts(): Promise<{ accounts: RouterAccount[] }> {
    const c = this.connection();
    await this.info(c);
    return routerRequest(c.socketPath, "/v1/accounts", c.token);
  }
  async catalog(accountId: string): Promise<{ models: RouterModel[] }> {
    const c = this.connection();
    await this.info(c);
    return routerRequest(c.socketPath, "/v1/catalog", c.token, { accountId });
  }
  async quotas(accountId: string): Promise<unknown> {
    const c = this.connection();
    await this.info(c);
    return routerRequest(c.socketPath, "/v1/quotas", c.token, { accountId });
  }
  private async flushCancellations(c: Connection): Promise<void> {
    for (const allocation of Object.values(this.state.allocations)) {
      if (
        allocation.connectionId !== c.id ||
        !allocation.cancelled ||
        allocation.cancellationAcknowledged
      )
        continue;
      await routerRequest(c.socketPath, "/v1/bindings/cancel", c.token, {
        id: allocation.id,
      });
      await this.save({
        ...this.state,
        allocations: {
          ...this.state.allocations,
          [allocation.id]: { ...allocation, cancellationAcknowledged: true },
        },
      });
    }
  }
  poolOperation<T>(path: string, body: object): Promise<T> {
    return this.serialize(async () => {
      const c = this.connection();
      const info = await this.info(c);
      if (!info.capabilities.includes("pools-v1"))
        throw new RouterUnavailable(
          409,
          "Update AAR to use pools and the quota overview.",
          "unsupported",
        );
      const ownerManaged = info.capabilities.includes("router-owned-pools-v1");
      if (
        ownerManaged &&
        (path === "/v1/pools/save" || path === "/v1/pools/remove")
      )
        throw new RouterUnavailable(
          403,
          "Manage accounts, pools and grants in Agent Auth Router.",
          "operation-rejected",
        );
      const result = await routerRequest<T>(c.socketPath, path, c.token, body);
      // The router's own policy list and labels pass through unchanged.
      if (path === "/v1/overview" || path === "/v1/overview/refresh")
        return {
          ...withCliModels(result, info),
          canManagePools: !ownerManaged,
          admissionRefresh: info.capabilities.includes("admission-refresh-v1"),
        };
      return result;
    });
  }
  /** Best effort: a missing label never blocks a launch. */
  private async poolLabel(
    c: Connection,
    poolId: string,
  ): Promise<string | undefined> {
    try {
      const { pools } = await routerRequest<AgentAuthRouterOverview>(
        c.socketPath,
        "/v1/overview",
        c.token,
        {},
      );
      return routerLabel(pools.find((p) => p.id === poolId)?.name);
    } catch {
      return undefined;
    }
  }
  private readonly discoveryJobs = new Map<
    string,
    Promise<AgentAuthRouterOverview>
  >();
  /** On-demand support observation, with no account/provider I/O or state mutation. */
  async supportsServiceTierSelection(): Promise<boolean> {
    const c = this.state.connection;
    if (c?.state !== "connected") return false;
    try {
      return (await this.info(c)).capabilities.includes("service-tiers-v1");
    } catch (error) {
      if (error instanceof RouterUnavailable) return false;
      throw error;
    }
  }
  async selection(provider: unknown): Promise<AgentAuthRouterOverview | null> {
    if (provider !== "claude" && provider !== "codex")
      throw new RouterUnavailable(400, "Invalid router provider");
    if (this.summary().state === "disconnected") return null;
    const c = this.connection();
    const key = `${c.id}:${provider}`;
    let job = this.discoveryJobs.get(key);
    if (!job) {
      job = (async () => {
        const info = await this.info(c);
        const result = await routerRequest<AgentAuthRouterOverview>(
          c.socketPath,
          "/v1/selection",
          c.token,
          { provider },
        );
        if (this.connection().id !== c.id)
          throw new RouterUnavailable(409, "Router connection changed");
        return withCliModels(result, info);
      })().finally(() => this.discoveryJobs.delete(key));
      this.discoveryJobs.set(key, job);
    }
    return job;
  }
  overview(
    body: {
      poolId?: string;
      model?: string;
      policy?: AgentAuthRouterPoolPolicy;
    } = {},
  ): Promise<AgentAuthRouterOverview> {
    return this.poolOperation("/v1/overview", body);
  }
  refreshOverview(body: {
    accountId: string;
    poolId?: string;
    model?: string;
  }): Promise<AgentAuthRouterOverview> {
    return this.poolOperation("/v1/overview/refresh", body);
  }
  savePool(body: AgentAuthRouterPoolInput): Promise<unknown> {
    return this.poolOperation("/v1/pools/save", body);
  }
  removePool(body: { id: string; revision: number }): Promise<unknown> {
    return this.poolOperation("/v1/pools/remove", body);
  }
  /** Failed fresh launches never leave a usable credential intentionally retained. */
  cancel(sessionId: string): Promise<void> {
    return this.serialize(async () => {
      const ref = this.metadata?.getMetadata(sessionId)?.routerBinding;
      const allocation = ref && this.state.allocations[ref.id];
      if (!allocation) return;
      await this.save({
        ...this.state,
        allocations: {
          ...this.state.allocations,
          [allocation.id]: { ...allocation, cancelled: true },
        },
      });
      const c = this.connection();
      await this.info(c);
      await this.flushCancellations(c);
    });
  }
  /**
   * Refuse before copying a transcript whose child could not inherit this
   * session's pin. Synchronous, so a fork never starts on a stale connection.
   */
  assertInheritable(parentSessionId: string): void {
    const binding = this.metadata?.getMetadata(parentSessionId)?.routerBinding;
    if (binding) this.inheritable(binding);
  }
  private inheritable(binding: NonNullable<SessionMetadata["routerBinding"]>): {
    c: Connection;
    source: Allocation;
  } {
    const c = this.connection();
    const source = this.state.allocations[binding.id];
    if (
      !source ||
      source.cancelled ||
      !source.accountId ||
      source.connectionId !== c.id ||
      binding.routerId !== c.routerId
    )
      throw new RouterUnavailable(
        409,
        "This session lost its router binding, so a copy could not keep its account. Start a new session instead.",
      );
    return { c, source };
  }
  /**
   * Give a forked or cloned child its own binding for the parent's account:
   * a separate allocation and token, never a reselection
   * (docs/tactical/150-ya-owned-session-ids.md step 8). The router prepares
   * and commits it at the child's first launch, like any pinned resume, and a
   * rejection there stays retryable. The child's metadata is written first,
   * so a failure after that leaves a child that refuses to launch; the
   * Supervisor discards a copy whose inheritance fails at all.
   */
  inheritBinding(
    parentSessionId: string,
    childSessionId: string,
  ): Promise<void> {
    return this.serialize(async () => {
      if (!this.metadata)
        throw new RouterUnavailable(409, "Router metadata unavailable");
      const parent = this.metadata.getMetadata(parentSessionId)?.routerBinding;
      if (!parent) return;
      const id = randomUUID();
      await this.metadata.updateMetadata(childSessionId, {
        routerBinding: {
          id,
          routerId: parent.routerId,
          accountId: parent.accountId,
          accountDisplayName: parent.accountDisplayName,
          provider: parent.provider,
          ...(parent.poolId
            ? {
                poolId: parent.poolId,
                poolName: parent.poolName,
                policy: "manual",
              }
            : {}),
          reason: "Inherited from the copied session's account",
        },
      });
      const { c, source } = this.inheritable(parent);
      await this.save({
        ...this.state,
        allocations: {
          ...this.state.allocations,
          [id]: {
            id,
            connectionId: c.id,
            accountId: source.accountId,
            ...(source.poolId
              ? {
                  poolId: source.poolId,
                  policy: "manual" as const,
                  requestedAccountId: source.accountId,
                }
              : {}),
            provider: source.provider,
            model: source.model,
            thinking: source.thinking,
            serviceTier:
              this.metadata.getMetadata(childSessionId)?.effectiveLaunchSettings
                ?.serviceTier ?? undefined,
            token: token("aar_"),
          },
        },
      });
    });
  }
  async validateSessionSettings(
    sessionId: string,
    model: string | undefined,
    settings?: {
      thinking?: ThinkingConfig;
      effort?: EffortLevel;
      serviceTier?: string;
    },
  ): Promise<void> {
    const binding = this.metadata?.getMetadata(sessionId)?.routerBinding;
    if (!binding) return;
    const allocation = this.state.allocations[binding.id];
    const c = this.connection();
    if (
      !allocation ||
      allocation.connectionId !== c.id ||
      binding.routerId !== c.routerId
    )
      throw new RouterUnavailable(409, "Session router binding unavailable");
    const info = await this.info(c);
    if (
      settings?.serviceTier &&
      !info.capabilities.includes("service-tiers-v1")
    )
      throw new RouterUnavailable(
        409,
        "Update AAR to select a speed tier.",
        "unsupported",
      );
    const { models } = await this.catalog(binding.accountId);
    const thinking: ThinkingOption =
      settings?.thinking?.type === "disabled"
        ? "off"
        : settings?.effort
          ? `on:${settings.effort}`
          : "auto";
    if (
      !routerModelSupportsThinking(
        models.find((m) => m.id === (model ?? allocation.model)),
        thinking,
      )
    )
      throw new RouterUnavailable(
        409,
        "The pinned account does not support the selected model and thinking level",
      );
    if (
      !routerModelSupportsServiceTier(
        models.find((m) => m.id === (model ?? allocation.model)),
        settings?.serviceTier,
      )
    )
      throw new RouterUnavailable(
        409,
        "The pinned account does not support the selected speed tier",
      );
  }
  async launch(
    sessionId: string,
    provider: string,
    model: string | undefined,
    accountId?: string,
    poolId?: string,
    policy?: AgentAuthRouterPoolPolicy,
    settings?: {
      thinking?: ThinkingConfig;
      effort?: EffortLevel;
      serviceTier?: string;
    },
  ): Promise<RouterLaunch | undefined> {
    return this.serialize(async () => {
      const existing = this.metadata?.getMetadata(sessionId)?.routerBinding;
      if (!existing && !accountId && !poolId) return undefined;
      if (!this.metadata || (provider !== "claude" && provider !== "codex"))
        throw new RouterUnavailable(
          409,
          "Router requires a retained native Claude or Codex session",
        );
      const c = this.connection(),
        info = await this.info(c);
      if (poolId && !info.capabilities.includes("pools-v1"))
        throw new RouterUnavailable(
          409,
          "Update AAR to use pools.",
          "unsupported",
        );
      if (
        settings?.serviceTier &&
        !info.capabilities.includes("service-tiers-v1")
      )
        throw new RouterUnavailable(
          409,
          "Update AAR to select a speed tier.",
          "unsupported",
        );
      await this.flushCancellations(c);
      let allocation = existing
        ? this.state.allocations[existing.id]
        : undefined;
      if (
        existing &&
        (!allocation ||
          allocation.connectionId !== c.id ||
          existing.routerId !== c.routerId)
      )
        throw new RouterUnavailable(
          409,
          "This session lost its router binding; it cannot use a different account",
        );
      if (allocation?.cancelled)
        throw new RouterUnavailable(
          409,
          "This failed launch was cancelled; create a new session. If cleanup is pending, retry failed-launch cleanup in Settings → Providers first.",
        );
      if (
        allocation &&
        (allocation.provider !== provider ||
          (accountId && allocation.accountId !== accountId) ||
          (poolId && allocation.poolId !== poolId))
      )
        throw new RouterUnavailable(409, "Session account pin cannot change");
      const selectedId = allocation?.accountId ?? accountId;
      const { accounts } = await routerRequest<{ accounts: RouterAccount[] }>(
        c.socketPath,
        "/v1/accounts",
        c.token,
      );
      const accountName = (id: string | undefined) =>
        routerLabel(accounts.find((a) => a.id === id)?.displayName);
      if (
        selectedId &&
        !accounts.some(
          (a) => a.id === selectedId && a.provider === provider && a.enabled,
        )
      ) {
        const pinned = existing?.accountDisplayName;
        throw new RouterUnavailable(
          409,
          `The pinned router account${pinned ? ` (${pinned})` : ""} is disabled, removed, or no longer granted. Re-enable the same account in AAR and retry, or start a new session with an available account. This session's pin will not change.`,
          "account-unavailable",
        );
      }
      // A rename in AAR reaches the saved label whenever the pin resumes.
      const currentName = existing && accountName(existing.accountId);
      if (
        existing &&
        currentName &&
        currentName !== existing.accountDisplayName
      )
        await this.metadata.updateMetadata(sessionId, {
          routerBinding: { ...existing, accountDisplayName: currentName },
        });
      const requestedThinking: ThinkingOption =
        settings?.thinking?.type === "disabled"
          ? "off"
          : settings?.effort
            ? `on:${settings.effort}`
            : "auto";
      if (!allocation) {
        if (!model || (!accountId && !poolId))
          throw new RouterUnavailable(
            400,
            "Choose a router account and catalog model",
          );
        allocation = {
          id: randomUUID(),
          connectionId: c.id,
          accountId: accountId ?? "",
          ...(poolId ? { poolId, policy, requestedAccountId: accountId } : {}),
          provider,
          model,
          thinking: requestedThinking,
          ...(settings?.serviceTier
            ? { serviceTier: settings.serviceTier }
            : {}),
          token: token("aar_"),
        };
        await this.save({
          ...this.state,
          allocations: {
            ...this.state.allocations,
            [allocation.id]: allocation,
          },
        });
        await this.metadata.updateMetadata(sessionId, {
          routerBinding: {
            id: allocation.id,
            routerId: c.routerId,
            accountId: accountId ?? "",
            ...(poolId
              ? { poolId, policy }
              : { accountDisplayName: accountName(accountId) }),
            provider,
          },
        });
      }
      let accountModels: ModelInfo[] = [];
      try {
        const selected = await routerRequest<{
          accountId: string;
          poolId?: string;
          policy?: AgentAuthRouterPoolPolicy;
          reason?: string;
          observedAt?: string;
        }>(
          c.socketPath,
          allocation.poolId ? "/v1/pools/prepare" : "/v1/bindings/prepare",
          c.token,
          {
            id: allocation.id,
            provider,
            ...(allocation.poolId
              ? {
                  poolId: allocation.poolId,
                  // Routers before 2026-10-11 admit only policies a client lists.
                  supportedPolicies: info.supportedPolicies ?? [
                    "manual",
                    "round-robin",
                  ],
                  policy: allocation.policy,
                  accountId: allocation.requestedAccountId,
                }
              : { accountId: allocation.accountId }),
            model: allocation.model,
            thinking: allocation.thinking,
            ...(allocation.serviceTier
              ? { serviceTier: allocation.serviceTier }
              : {}),
            tokenHash: hash(allocation.token),
          },
        );
        const pinnedPoolId = allocation.poolId;
        if (pinnedPoolId) {
          if (
            !selected.accountId ||
            (allocation.accountId &&
              allocation.accountId !== selected.accountId)
          )
            throw new RouterUnavailable(
              409,
              "Router returned a conflicting account pin",
            );
          allocation = { ...allocation, accountId: selected.accountId };
          await this.save({
            ...this.state,
            allocations: {
              ...this.state.allocations,
              [allocation.id]: allocation,
            },
          });
          await this.metadata.updateMetadata(sessionId, {
            routerBinding: {
              id: allocation.id,
              routerId: c.routerId,
              accountId: selected.accountId,
              accountDisplayName:
                accountName(selected.accountId) ?? existing?.accountDisplayName,
              provider,
              poolId: pinnedPoolId,
              poolName:
                existing?.poolName ?? (await this.poolLabel(c, pinnedPoolId)),
              policy: selected.policy,
              policyLabel: routerLabel(
                info.policies?.find((p) => p.id === selected.policy)?.label,
              ),
              reason: selected.reason,
              observedAt: selected.observedAt,
            },
          });
        }
        accountModels = (await this.catalog(allocation.accountId)).models;
        const requestedModel = model ?? allocation.model;
        if (
          !routerModelSupportsThinking(
            accountModels.find((m) => m.id === requestedModel),
            requestedThinking,
          )
        )
          throw new RouterUnavailable(
            409,
            "The pinned account does not support the selected model and thinking level",
          );
        if (
          !routerModelSupportsServiceTier(
            accountModels.find((m) => m.id === requestedModel),
            settings?.serviceTier,
          )
        )
          throw new RouterUnavailable(
            409,
            "The pinned account does not support the selected speed tier",
          );
        await routerRequest(c.socketPath, "/v1/bindings/commit", c.token, {
          id: allocation.id,
        });
      } catch (error) {
        // Definitive rejection of a fresh launch must not leave a usable reservation.
        // Lost replies remain recoverable through the persisted allocation identity.
        // An inherited binding is an existing pin: a rejection stays retryable.
        if (
          !existing &&
          error instanceof RouterUnavailable &&
          [400, 404, 409].includes(error.status)
        ) {
          await this.save({
            ...this.state,
            allocations: {
              ...this.state.allocations,
              [allocation.id]: { ...allocation, cancelled: true },
            },
          });
          try {
            await this.flushCancellations(c);
          } catch {
            /* Durable cleanup remains available in Settings. */
          }
        }
        if (error instanceof RouterUnavailable && error.loginRequired)
          throw routerLoginRequired(
            accountName(allocation.accountId) ?? existing?.accountDisplayName,
          );
        throw error;
      }
      return {
        models: accountModels,
        serviceTierSelection: info.capabilities.includes("service-tiers-v1"),
        bindingId: allocation.id,
        accountId: allocation.accountId,
        baseUrl: `${info.inferenceOrigin}/${provider}`,
        token: allocation.token,
      };
    });
  }
}
