import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { routerModelSupportsThinking } from "@yep-anywhere/shared";
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
} from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import { writeFileAtomically } from "../utils/writeFileAtomically.js";

export interface RouterLaunch {
  models?: ModelInfo[];
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
}
export interface RouterAccount {
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
  ) {
    super(message);
  }
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const token = (prefix: string) =>
  prefix + randomBytes(32).toString("base64url");
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
          if (response.statusCode !== 200)
            return reject(
              new RouterUnavailable(
                response.statusCode ?? 503,
                response.statusCode === 401
                  ? "Router connection revoked. Finish disconnecting in Settings → Providers, then reconnect for new sessions. Existing sessions cannot adopt a new pairing."
                  : "Router rejected the operation. Check the pinned account and model in Settings → Providers, then retry. No account was substituted.",
                response.statusCode === 401 ? "revoked" : "operation-rejected",
              ),
            );
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
  summary() {
    const c = this.state.connection;
    return { state: c?.state ?? "disconnected", routerId: c?.routerId ?? null };
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
        socketPath ??
          (keep
            ? previous.socketPath
            : join(homedir(), ".agent-auth-router", "control.sock")),
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
      if (
        (body as { policy?: string }).policy === "most-remaining" &&
        !info.capabilities.includes("most-remaining-v1")
      )
        throw new RouterUnavailable(
          409,
          "Update AAR to use Most remaining.",
          "unsupported",
        );
      const result = await routerRequest<T>(c.socketPath, path, c.token, body);
      if (path === "/v1/overview" || path === "/v1/overview/refresh")
        return {
          ...result,
          canManagePools: !ownerManaged,
          supportedPolicies: info.capabilities.includes("most-remaining-v1")
            ? ["manual", "round-robin", "most-remaining"]
            : ["manual", "round-robin"],
          admissionRefresh: info.capabilities.includes("admission-refresh-v1"),
        };
      return result;
    });
  }
  private readonly discoveryJobs = new Map<
    string,
    Promise<AgentAuthRouterOverview>
  >();
  async selection(provider: unknown): Promise<AgentAuthRouterOverview | null> {
    if (provider !== "claude" && provider !== "codex")
      throw new RouterUnavailable(400, "Invalid router provider");
    if (this.summary().state === "disconnected") return null;
    const c = this.connection();
    const key = `${c.id}:${provider}`;
    let job = this.discoveryJobs.get(key);
    if (!job) {
      job = (async () => {
        await this.info(c);
        const result = await routerRequest<AgentAuthRouterOverview>(
          c.socketPath,
          "/v1/selection",
          c.token,
          { provider },
        );
        if (this.connection().id !== c.id)
          throw new RouterUnavailable(409, "Router connection changed");
        return result;
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
  async validateSessionSettings(
    sessionId: string,
    model: string | undefined,
    settings?: { thinking?: ThinkingConfig; effort?: EffortLevel },
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
    await this.info(c);
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
  }
  async launch(
    sessionId: string,
    provider: string,
    model: string | undefined,
    accountId?: string,
    poolId?: string,
    policy?: AgentAuthRouterPoolPolicy,
    settings?: { thinking?: ThinkingConfig; effort?: EffortLevel },
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
        !existing &&
        policy === "most-remaining" &&
        !info.capabilities.includes("most-remaining-v1")
      )
        throw new RouterUnavailable(
          409,
          "Update AAR to use Most remaining.",
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
      if (
        selectedId &&
        !accounts.some(
          (a) => a.id === selectedId && a.provider === provider && a.enabled,
        )
      )
        throw new RouterUnavailable(
          409,
          "The pinned router account is disabled, removed, or no longer granted. Re-enable the same account in AAR and retry, or start a new session with an available account. This session's pin will not change.",
          "account-unavailable",
        );
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
            ...(poolId ? { poolId, policy } : {}),
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
                  supportedPolicies: [
                    "manual",
                    "round-robin",
                    "most-remaining",
                  ],
                  policy: allocation.policy,
                  accountId: allocation.requestedAccountId,
                }
              : { accountId: allocation.accountId }),
            model: allocation.model,
            thinking: allocation.thinking,
            tokenHash: hash(allocation.token),
          },
        );
        if (allocation.poolId) {
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
              provider,
              poolId: allocation.poolId,
              policy: selected.policy,
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
        await routerRequest(c.socketPath, "/v1/bindings/commit", c.token, {
          id: allocation.id,
        });
      } catch (error) {
        // Definitive rejection of a fresh launch must not leave a usable reservation.
        // Lost replies remain recoverable through the persisted allocation identity.
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
        throw error;
      }
      return {
        models: accountModels,
        bindingId: allocation.id,
        accountId: allocation.accountId,
        baseUrl: `${info.inferenceOrigin}/${provider}`,
        token: allocation.token,
      };
    });
  }
}
