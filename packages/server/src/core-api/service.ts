import { relatedQuery } from "./relationship-graph-contracts.js";
import type { SessionRelationshipRead } from "../sessions/session-relationship-read.js";
import { receiptFollowQuery } from "./receipt-follow.js";
import {
  createSessionRequest,
  sendMessageRequest,
} from "./command-contracts.js";
import type { SessionCommands } from "./session-commands.js";
import {
  conversationQuery,
  followQuery,
  type ApiConversationFollow,
  type ConversationFollowQuery,
  type ApiConversation,
  type ConversationReadQuery,
} from "./conversation.js";
import {
  assertPeerOperation,
  peerProject,
  peerCreator,
  type ApiPrincipal,
} from "./peer-policy.js";
import type { ApiReceipt } from "./command-contracts.js";
import { levelFor } from "../auth/limitedUserPolicy.js";
import {
  API_REVISION,
  apiHelp,
  apiSchema,
  operationIds,
  readOperationIds,
  sessionSchema,
  serverMetadataSchema,
  type ApiServerMetadata,
  pageQuery,
  type ApiProject,
  type ApiProvider,
  type ApiSession,
  type CatalogState,
  type Operation,
  type PageQuery,
  type ApiLaunchContext,
} from "./contracts.js";

export interface CoreApiSources {
  relationships?: SessionRelationshipRead;
  peerAuthentication?: () => boolean;
  /** Cheap local display facts; does not discover providers or probe peers. */
  serverMetadata?(): ApiServerMetadata;
  commands?: SessionCommands;
  managementEnabled?: () => boolean;
  projects(
    signal?: AbortSignal,
  ): Promise<{ items: ApiProject[]; catalog?: CatalogState }>;
  sessions(
    signal?: AbortSignal,
  ): Promise<{ items: ApiSession[]; catalog?: CatalogState }>;
  providers(signal?: AbortSignal): Promise<ApiProvider[]>;
  conversation?(
    sessionId: string,
    query: ConversationReadQuery,
    signal?: AbortSignal,
  ): Promise<ApiConversation>;
  followConversation?(
    sessionId: string,
    query: ConversationFollowQuery,
    signal?: AbortSignal,
  ): Promise<ApiConversationFollow>;
  hiddenProjects?(username: string): Promise<ReadonlySet<string>>;
}
export { CoreApiError } from "./errors.js";
import { CoreApiError } from "./errors.js";

const describePrincipal = (principal: ApiPrincipal) =>
  principal.kind === "limited"
    ? { kind: principal.kind, username: principal.username }
    : principal.kind === "peer"
      ? { kind: principal.kind, serverId: principal.serverId }
      : { kind: principal.kind };

/** Application operations have no HTTP, provider-registry or discovery ownership. */
export class CoreApi {
  constructor(
    readonly serverId: string,
    private readonly sources: CoreApiSources,
  ) {}

  /** Canonical dispatcher. read remains the incumbent controller-port alias. */
  call(...args: Parameters<CoreApi["read"]>) {
    return this.read(...args);
  }

  async read(
    operation: Operation,
    caller: ApiPrincipal,
    input: {
      serverId?: string;
      sessionId?: string;
      receiptId?: string;
      body?: unknown;
      query?: PageQuery &
        ConversationFollowQuery & {
          operation?: string;
          includeRelated?: string;
          relatedLimit?: string;
          relatedCursor?: string;
        };
      signal?: AbortSignal;
      /** Established by a trusted launch authenticator, never a request field. */
      launch?: ApiLaunchContext;
      /** Independent owner proof from the host, never a public request field. */
      ownerAuthenticated?: true;
    } = {},
  ) {
    assertPeerOperation(caller, operation);
    if (caller.kind === "peer")
      input = {
        ...input,
        signal: AbortSignal.any([
          caller.signal,
          ...(input.signal ? [input.signal] : []),
        ]),
      };
    let releaseCancellation = () => {};
    const cancelled =
      caller.kind === "peer"
        ? new Promise<never>((_resolve, reject) => {
            const signal = input.signal!;
            const abort = () =>
              reject(
                signal.reason instanceof CoreApiError
                  ? signal.reason
                  : new CoreApiError(
                      "controller_unavailable",
                      "Peer request was cancelled",
                      503,
                    ),
              );
            signal.addEventListener("abort", abort, { once: true });
            releaseCancellation = () =>
              signal.removeEventListener("abort", abort);
            if (signal.aborted) abort();
          })
        : undefined;
    try {
      const pending = this.dispatch(operation, caller, input);
      const result = await (cancelled
        ? Promise.race([pending, cancelled])
        : pending);
      if (operation === "createSession" || operation === "sendMessage")
        await this.assertReceipt(caller, result as ApiReceipt, input.signal);
      return operation === "sendMessage"
        ? { ...(result as ApiReceipt), requestedSessionId: input.sessionId }
        : result;
    } catch (error) {
      // A payload conflict itself reveals a scoped receipt. Authorize it even
      // when reserve/lookup discovered it after an asynchronous catalog read.
      if (
        caller.kind === "peer" &&
        error instanceof CoreApiError &&
        error.code === "request_id_conflict"
      ) {
        const commands = this.sources.commands!;
        const creator = peerCreator(caller);
        const receipt =
          operation === "createSession"
            ? commands.replayCreate(
                createSessionRequest.parse(input.body),
                input.launch,
                creator,
                false,
              )
            : commands.replaySend(
                input.sessionId!,
                sendMessageRequest.parse(input.body),
                input.launch,
                creator,
                false,
              );
        await this.assertReceipt(caller, receipt, input.signal);
      }
      throw error;
    } finally {
      releaseCancellation();
      if (caller.kind === "peer") caller.assertActive();
    }
  }

  private async dispatch(
    operation: Operation,
    caller: ApiPrincipal,
    input: Parameters<CoreApi["read"]>[2] = {},
  ) {
    input.signal?.throwIfAborted();
    if (input.serverId !== undefined && input.serverId !== this.serverId) {
      throw new CoreApiError(
        "server_not_found",
        "Server is not configured here",
        404,
      );
    }
    if (input.query?.projectId !== undefined && operation !== "sessions") {
      throw new CoreApiError(
        "invalid_request",
        "projectId is only supported for the session catalog",
        400,
      );
    }
    const selected = input.query?.operation;
    if (
      selected &&
      (!["help", "schema"].includes(operation) ||
        !operationIds.includes(selected as Operation))
    )
      throw new CoreApiError(
        "invalid_request",
        "Unknown or unsupported documentation operation selector",
        400,
      );
    const query = pageQuery.safeParse(input.query ?? {});
    if (!query.success)
      throw new CoreApiError(
        "invalid_request",
        "Invalid pagination or project filter",
        400,
      );
    const visible = (projectId: string) =>
      caller.kind === "superuser" ||
      (caller.kind === "peer"
        ? peerProject(caller, projectId)
        : levelFor(caller.grants, projectId) !== "none");
    const server = () => ({
      ...serverMetadataSchema.parse(this.sources.serverMetadata?.() ?? {}),
      id: this.serverId,
      local: true as const,
    });
    switch (operation) {
      case "describe":
        return {
          serverId: this.serverId,
          revision: API_REVISION,
          stability: "unstable",
          schema: "/v0/schema",
          help: "/v0/help",
          me: "/v0/me",
          servers: "/v0/servers",
        };
      case "help":
        return apiHelp(selected as Operation | undefined);
      case "schema":
        return apiSchema(
          Boolean(input.launch),
          selected as Operation | undefined,
        );
      case "me":
        return {
          principal: describePrincipal(caller),
          session: input.launch ?? null,
          server: server(),
          observedAt: new Date().toISOString(),
          links: {
            help: "/v0/help",
            schema: "/v0/schema",
            access: `/v0/servers/${encodeURIComponent(this.serverId)}/access`,
            session: input.launch?.id
              ? `/v0/servers/${encodeURIComponent(this.serverId)}/sessions/${encodeURIComponent(input.launch.id)}`
              : null,
          },
        };
      case "servers":
        return { items: [server()], nextCursor: null };
      case "server":
        return server();
      case "access":
        return {
          principal: describePrincipal(caller),
          scope:
            caller.kind === "superuser" ||
            (caller.kind === "peer" && caller.allProjects)
              ? "all-projects"
              : "project-grants",
          operations: operationIds.filter((id) => {
            if (caller.kind === "peer")
              return (
                caller.operations.includes(id) &&
                (readOperationIds.includes(id) ||
                  Boolean(this.sources.commands?.enabled()))
              );
            if (
              caller.kind !== "superuser" &&
              [
                "receipt",
                "relationships",
                "createSession",
                "sendMessage",
                "followReceipt",
              ].includes(id)
            )
              return false;
            if (readOperationIds.includes(id)) return true;
            return Boolean(
              (this.sources.managementEnabled?.() ??
                this.sources.commands?.enabled()) &&
                (!input.launch || (input.launch.management && input.launch.id)),
            );
          }),
        };
      case "capabilities":
        return {
          revision: API_REVISION,
          stability: "unstable",
          operations: operationIds,
          peerRouting: false,
          ...(this.sources.peerAuthentication?.()
            ? { peerAuthentication: "refresh-v1" as const }
            : {}),
        };
      case "providers":
        return this.page(
          await this.sources.providers(input.signal),
          query.data,
        );
      case "projects": {
        const result = await this.sources.projects(input.signal);
        const hidden =
          caller.kind === "limited"
            ? await this.sources.hiddenProjects?.(caller.username)
            : undefined;
        return {
          ...this.page(
            result.items
              .filter((p) => visible(p.id) && !hidden?.has(p.id))
              .sort((a, b) => a.id.localeCompare(b.id)),
            query.data,
          ),
          catalog: result.catalog,
        };
      }
      case "createSession": {
        const commands = this.commandAccess(caller, input.launch);
        const body = createSessionRequest.safeParse(input.body);
        if (!body.success)
          throw new CoreApiError(
            "invalid_request",
            "Invalid native session creation request; inspect this operation's schema",
            400,
          );
        if (!visible(body.data.projectId))
          throw new CoreApiError("project_not_found", "Project not found", 404);
        const authenticated =
          caller.kind === "peer" ? peerCreator(caller) : undefined;
        const replay = commands.replayCreate(
          body.data,
          input.launch,
          authenticated,
        );
        if (replay) {
          await this.assertReceipt(caller, replay, input.signal);
          return replay;
        }
        const [projects, providers] = await Promise.all([
          this.sources.projects(input.signal),
          this.sources.providers(input.signal),
        ]);
        const project = projects.items.find(
          (project) => project.id === body.data.projectId,
        );
        if (!project)
          throw new CoreApiError(
            projects.catalog?.complete === false
              ? "catalog_not_ready"
              : "project_not_found",
            "Project is not available in this server's catalog",
            projects.catalog?.complete === false ? 503 : 404,
          );
        if (!providers.some((provider) => provider.id === body.data.provider))
          throw new CoreApiError(
            "invalid_request",
            "Provider is not configured on this server",
            400,
          );
        input.signal?.throwIfAborted();
        assertPeerOperation(caller, operation);
        return commands.create(
          project,
          body.data,
          input.launch,
          authenticated,
          async () => {
            this.commandAccess(caller, input.launch);
            assertPeerOperation(caller, operation);
            if (!visible(project.id))
              throw new CoreApiError(
                "forbidden",
                "Project creation authority is no longer active",
                403,
              );
          },
        );
      }
      case "sendMessage": {
        const commands = this.commandAccess(caller, input.launch);
        const body = sendMessageRequest.safeParse(input.body);
        if (!body.success)
          throw new CoreApiError(
            "invalid_request",
            "Invalid queued input request; inspect this operation's schema",
            400,
          );
        const authenticated =
          caller.kind === "peer" ? peerCreator(caller) : undefined;
        const replay = commands.replaySend(
          input.sessionId!,
          body.data,
          input.launch,
          authenticated,
        );
        if (replay) {
          await this.assertReceipt(caller, replay, input.signal);
          return replay;
        }
        const session = sessionSchema.parse(
          await this.read("session", caller, { ...input, query: undefined }),
        );
        input.signal?.throwIfAborted();
        assertPeerOperation(caller, operation);
        return commands.send(session, body.data, input.launch, authenticated);
      }
      case "followReceipt": {
        if (caller.kind === "limited")
          throw new CoreApiError(
            "forbidden",
            "Receipt access requires operator authority",
            403,
          );
        const query = receiptFollowQuery.safeParse(input.query ?? {});
        if (!query.success)
          throw new CoreApiError(
            "invalid_request",
            "Invalid receipt cursor or wait",
            400,
          );
        if (!this.sources.commands)
          throw new CoreApiError("receipt_not_found", "Receipt not found", 404);
        await this.assertReceipt(
          caller,
          this.sources.commands.store.get(input.receiptId!),
          input.signal,
        );
        const followed = await this.sources.commands.follow(
          input.receiptId!,
          query.data,
          caller.kind === "peer"
            ? AbortSignal.any([
                caller.signal,
                ...(input.signal ? [input.signal] : []),
              ])
            : input.signal,
        );
        await this.assertReceipt(
          caller,
          this.sources.commands.store.get(input.receiptId!),
          input.signal,
        );
        return followed;
      }
      case "receipt": {
        if (caller.kind === "limited")
          throw new CoreApiError(
            "forbidden",
            "Receipt access requires operator authority",
            403,
          );
        await this.assertReceipt(
          caller,
          this.sources.commands?.store.get(input.receiptId ?? ""),
          input.signal,
        );
        const receipt = await this.sources.commands?.receipt(
          input.receiptId ?? "",
        );
        if (!receipt)
          throw new CoreApiError("receipt_not_found", "Receipt not found", 404);
        await this.assertReceipt(caller, receipt, input.signal);
        return receipt;
      }
      case "relationships": {
        if (caller.kind === "limited")
          throw new CoreApiError(
            "forbidden",
            "Provenance access requires operator authority",
            403,
          );
        await this.read("session", caller, { ...input, query: undefined });
        if (caller.kind === "peer") {
          const creation = this.sources.commands?.store.relationships(
            input.sessionId!,
            0,
            1,
          ).creation;
          return {
            sessionId: input.sessionId!,
            creation:
              creation && this.receiptVisible(caller, creation)
                ? creation
                : null,
            initiated: [],
            nextCursor: null,
          };
        }
        const parsed = relatedQuery.safeParse(input.query ?? {});
        if (!parsed.success)
          throw new CoreApiError(
            "invalid_request",
            "Invalid related relationship query",
            400,
          );
        const related =
          parsed.data.includeRelated === "true"
            ? await this.sources.relationships?.({
                sessionId: input.sessionId!,
                query: {
                  limit: parsed.data.relatedLimit,
                  cursor: parsed.data.relatedCursor,
                },
                signal: input.signal,
              })
            : undefined;
        const receipts = this.sources.commands?.store.relationships(
          input.sessionId!,
          Number(query.data.cursor ?? 0),
          Number(query.data.limit ?? 50),
        ) ?? {
          sessionId: input.sessionId!,
          creation: null,
          initiated: [],
          nextCursor: null,
        };
        return { ...receipts, ...(related ? { related } : {}) };
      }
      case "followConversation": {
        const parsed = followQuery.safeParse(input.query ?? {});
        if (!parsed.success)
          throw new CoreApiError(
            "invalid_request",
            "Invalid follow cursor or window",
            400,
          );
        await this.read("session", caller, { ...input, query: undefined });
        if (!this.sources.followConversation)
          throw new CoreApiError(
            "conversation_unavailable",
            "Conversation following is not configured",
            503,
          );
        return this.sources.followConversation(
          input.sessionId!,
          parsed.data,
          caller.kind === "peer"
            ? AbortSignal.any([
                caller.signal,
                ...(input.signal ? [input.signal] : []),
              ])
            : input.signal,
        );
      }
      case "conversation": {
        const parsed = conversationQuery.safeParse(input.query ?? {});
        if (!parsed.success)
          throw new CoreApiError(
            "invalid_request",
            "Invalid conversation window",
            400,
          );
        await this.read("session", caller, { ...input, query: undefined });
        if (!this.sources.conversation)
          throw new CoreApiError(
            "conversation_unavailable",
            "Conversation source is not configured",
            503,
          );
        return this.sources.conversation(
          input.sessionId!,
          parsed.data,
          caller.kind === "peer"
            ? AbortSignal.any([
                caller.signal,
                ...(input.signal ? [input.signal] : []),
              ])
            : input.signal,
        );
      }
      case "sessions":
      case "session": {
        const result = await this.sources.sessions(input.signal);
        const projectsById = new Map<string, string>();
        const ambiguous = new Set<string>();
        for (const item of result.items) {
          const previous = projectsById.get(item.id);
          if (previous !== undefined && previous !== item.projectId)
            ambiguous.add(item.id);
          projectsById.set(item.id, item.projectId);
        }
        const hidden =
          operation === "sessions" && caller.kind === "limited"
            ? await this.sources.hiddenProjects?.(caller.username)
            : undefined;
        const items = result.items.filter(
          (s) =>
            !ambiguous.has(s.id) &&
            (visible(s.projectId) ||
              (caller.kind === "limited" &&
                s.createdByUser === caller.username)) &&
            !hidden?.has(s.projectId) &&
            (!query.data.projectId || query.data.projectId === s.projectId),
        );
        if (operation === "session") {
          const item = items.find((s) => s.id === input.sessionId);
          if (!item && result.catalog?.complete === false)
            throw new CoreApiError(
              "catalog_not_ready",
              "Session catalog is not ready",
              503,
            );
          if (!item)
            throw new CoreApiError(
              "session_not_found",
              "Session not found",
              404,
            );
          return item;
        }
        const unique = [
          ...new Map(items.map((item) => [item.id, item])).values(),
        ];
        unique.sort(
          (a, b) =>
            (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) ||
            a.id.localeCompare(b.id),
        );
        return { ...this.page(unique, query.data), catalog: result.catalog };
      }
    }
  }

  private receiptVisible(caller: ApiPrincipal, receipt: ApiReceipt) {
    return (
      caller.kind !== "peer" ||
      (receipt.creator.principal.kind === "peer" &&
        receipt.creator.serverId === caller.serverId &&
        peerProject(caller, receipt.projectId))
    );
  }
  private async assertReceipt(
    caller: ApiPrincipal,
    receipt?: ApiReceipt,
    signal?: AbortSignal,
  ) {
    if (
      caller.kind === "peer" &&
      (!receipt || !this.receiptVisible(caller, receipt))
    )
      throw new CoreApiError("receipt_not_found", "Receipt not found", 404);
    if (caller.kind === "peer" && receipt?.sessionId)
      await this.read("session", caller, {
        serverId: this.serverId,
        sessionId: receipt.sessionId,
        signal,
      });
  }

  private commandAccess(
    caller: ApiPrincipal,
    launch?: ApiLaunchContext,
  ): SessionCommands {
    const commands = this.sources.commands;
    if (
      caller.kind === "limited" ||
      !commands?.enabled() ||
      (launch && !launch.management)
    )
      throw new CoreApiError(
        "forbidden",
        "Session commands require explicit management enablement and authority",
        403,
      );
    if (launch && !launch.id)
      throw new CoreApiError(
        "identity_pending",
        "Owning session is not bound yet",
        409,
      );
    return commands;
  }
  private page<T>(items: T[], query: PageQuery) {
    const offset = Number(query.cursor ?? 0),
      limit = Number(query.limit ?? 50);
    const end = offset + limit;
    return {
      items: items.slice(offset, end),
      nextCursor: end < items.length ? String(end) : null,
    };
  }
}

/** Transport-neutral controller port; adapters validate operation result schemas. */
export type ApiReadPort = (
  ...args: Parameters<CoreApi["read"]>
) => Promise<unknown>;
