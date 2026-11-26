import { createIssueStatusRoutes } from "./issue-status.js";
import { createIssueContentRoutes } from "./issue-content.js";
import type { IssueContentRefresher } from "../services/issues/content.js";
import { Hono, type MiddlewareHandler } from "hono";
import type {
  IssueSettings,
  IssueSession,
  IssueSort,
} from "@yep-anywhere/shared";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import type { IssueIndexer } from "../services/issues/IssueIndexer.js";
import type { IssueCredentials } from "../services/issues/credentials.js";
import type { IssueConfirmer } from "../services/issues/confirm.js";
import type { IssueStatusRefresher } from "../services/issues/status.js";
import { issueUrl } from "../services/issues/extract.js";
import {
  issueLookupUrl,
  DEFAULT_ISSUE_CONTENT_TTL_SECONDS,
  DEFAULT_ISSUE_STATUS_COMMENT_TTL_SECONDS,
  ISSUE_CONTENT_TTL_SECONDS,
  ISSUE_STATUS_COMMENT_TTL_SECONDS,
} from "@yep-anywhere/shared";

/** Rejects a confirmation block rather than storing a half-configured one. */
function confirmation(
  value: unknown,
): IssueSettings["confirmation"] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") return null;
  const { enabled, jiraSite, jiraEmail } = value as Record<string, unknown>;
  if (
    typeof enabled !== "boolean" ||
    typeof jiraSite !== "string" ||
    typeof jiraEmail !== "string" ||
    jiraSite.length > 512 ||
    jiraEmail.length > 512
  )
    return null;
  if (jiraSite && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(jiraSite)) return null;
  return { enabled, jiraSite, jiraEmail };
}

/** Uppercase, deduplicated, bounded; undefined means keep the default list. */
function blocklist(value: unknown): string[] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (name) =>
        typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name),
    )
  )
    return null;
  return [
    ...new Set((value as string[]).map((name) => name.toUpperCase())),
  ].sort();
}

export function createIssueRoutes(
  indexer: IssueIndexer,
  settings: ServerSettingsService,
  validSource: (
    projectId: string,
    sessionId: string,
  ) => Promise<{ available: boolean } & Partial<IssueSession>>,
  credentials?: IssueCredentials,
  confirmer?: IssueConfirmer,
  sessionCatalog: (sessionId?: string) => Promise<
    readonly {
      sessionId: string;
      updatedAt: string;
      title?: string | null;
      projectName?: string;
      provider?: IssueSession["provider"];
      createdAt?: string;
    }[]
  > = async () => [],
  statuses?: IssueStatusRefresher,
  content?: IssueContentRefresher,
) {
  const routes = new Hono();
  const settingsCoverage = () => {
    const coverage = indexer.coverage();
    return {
      ...coverage,
      settings: {
        ...coverage.settings,
        contentTtlSeconds:
          coverage.settings.contentTtlSeconds === undefined
            ? DEFAULT_ISSUE_CONTENT_TTL_SECONDS
            : coverage.settings.contentTtlSeconds,
        statusCommentTtlSeconds:
          coverage.settings.statusCommentTtlSeconds === undefined
            ? DEFAULT_ISSUE_STATUS_COMMENT_TTL_SECONDS
            : coverage.settings.statusCommentTtlSeconds,
      },
    };
  };
  routes.get("/issues/settings", (c) => c.json(settingsCoverage()));
  routes.put("/issues/settings", async (c) => {
    const body = (await c.req.json().catch(() => null)) as IssueSettings | null;
    const confirm = body ? confirmation(body.confirmation) : null;
    const cli = body?.githubCli;
    if (
      body &&
      ((body.contentTtlSeconds !== undefined &&
        !(ISSUE_CONTENT_TTL_SECONDS as readonly unknown[]).includes(
          body.contentTtlSeconds,
        )) ||
        (body.statusCommentTtlSeconds !== undefined &&
          !(ISSUE_STATUS_COMMENT_TTL_SECONDS as readonly unknown[]).includes(
            body.statusCommentTtlSeconds,
          )))
    )
      return c.json({ error: "Unsupported ticket cache lifetime" }, 400);
    if (
      body &&
      ((body.githubStatusEnabled !== undefined &&
        typeof body.githubStatusEnabled !== "boolean") ||
        (cli !== undefined &&
          (!cli ||
            typeof cli.enabled !== "boolean" ||
            typeof cli.account !== "string" ||
            (cli.account !== "" &&
              !/^[a-z\d][a-z\d-]{0,38}$/i.test(cli.account)))))
    )
      return c.json(
        {
          error:
            "Expected GitHub status boolean and CLI enabled/account settings",
        },
        400,
      );
    const blocked = body ? blocklist(body.jiraKeyBlocklist) : null;
    if (
      !body ||
      typeof body.enabled !== "boolean" ||
      !["viewed", "recent"].includes(body.scope) ||
      !Number.isInteger(body.recentDays) ||
      body.recentDays < 1 ||
      body.recentDays > 90 ||
      confirm === null ||
      blocked === null ||
      (body.aggressiveMatching !== undefined &&
        typeof body.aggressiveMatching !== "boolean")
    )
      return c.json(
        {
          error:
            "Expected enabled, scope (viewed/recent), recentDays (1–90), an https Jira site when confirmation is configured, and word-shaped blocked project keys",
        },
        400,
      );
    await settings.updateSettings({
      issueAssociations: {
        ...indexer.settings(),
        enabled: body.enabled,
        scope: body.scope,
        recentDays: body.recentDays,
        ...(body.contentTtlSeconds !== undefined
          ? { contentTtlSeconds: body.contentTtlSeconds }
          : {}),
        ...(body.statusCommentTtlSeconds !== undefined
          ? { statusCommentTtlSeconds: body.statusCommentTtlSeconds }
          : {}),
        aggressiveMatching: body.aggressiveMatching ?? false,
        ...(body.githubStatusEnabled !== undefined
          ? { githubStatusEnabled: body.githubStatusEnabled }
          : {}),
        ...(cli !== undefined
          ? { githubCli: { enabled: cli.enabled, account: cli.account } }
          : {}),
        ...(confirm ? { confirmation: confirm } : {}),
        ...(blocked ? { jiraKeyBlocklist: blocked } : {}),
      },
    });
    return c.json(settingsCoverage());
  });
  // Presence and origin only; a stored key is never returned to a client, and
  // this pair stays reachable while discovery is off so it can be set up first.
  routes.get("/issues/credentials", async (c) =>
    credentials
      ? c.json({ credentials: await credentials.status() })
      : c.json({ error: "Stored keys are unavailable on this server" }, 503),
  );
  routes.put("/issues/credentials", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      provider?: unknown;
      key?: unknown;
    } | null;
    const provider = body?.provider;
    const key = body?.key ?? "";
    if (
      !body ||
      (provider !== "github" && provider !== "jira") ||
      typeof key !== "string" ||
      key.length > 4096
    )
      return c.json({ error: "Expected provider (github/jira) and key" }, 400);
    if (!credentials)
      return c.json(
        { error: "Stored keys are unavailable on this server" },
        503,
      );
    try {
      await credentials.store(provider, key.trim());
    } catch {
      return c.json({ error: "The key could not be saved" }, 500);
    }
    return c.json({ credentials: await credentials.status() });
  });
  routes.route("/", createIssueStatusRoutes(statuses));
  const requireEnabled: MiddlewareHandler = async (c, next) => {
    if (!indexer.settings().enabled)
      return c.json({ error: "Issue associations are disabled" }, 403);
    await next();
  };
  routes.use("/issues", requireEnabled);
  routes.use("/issues/*", requireEnabled);
  const page = (limit: string | undefined, offset: string | undefined) => {
    const size = limit === undefined ? 50 : Number(limit),
      start = offset === undefined ? 0 : Number(offset);
    if (
      !Number.isInteger(size) ||
      size < 1 ||
      size > 100 ||
      !Number.isSafeInteger(start) ||
      start < 0
    )
      return null;
    return { size, start };
  };
  routes.get("/issues", async (c) => {
    const p = page(c.req.query("limit"), c.req.query("offset"));
    const query = c.req.query("q") ?? "";
    const supportedSorts: IssueSort[] = ["activity", "mentioned", "number"];
    const sort = c.req.query("sort") ?? "key";
    // An exact lookup names one item by any URL a browser shows for it. A
    // `ref` that names nothing matches nothing rather than falling back to q.
    const refValue = c.req.query("ref");
    const ref =
      refValue === undefined
        ? undefined
        : (issueLookupUrl(refValue)?.identity ?? "unrecognized:");
    if (
      !p ||
      query.length > 4096 ||
      (refValue?.length ?? 0) > 4096 ||
      (sort !== "key" && !supportedSorts.includes(sort as IssueSort))
    )
      return c.json({ error: "Invalid search or pagination" }, 400);
    const sessionId = c.req.query("sessionId") ?? "";
    const listed = indexer.store.list(
      issueUrl(query)?.url ?? query,
      c.req.query("projectId") ?? "",
      sessionId,
      c.req.query("dismissed") === "1",
      p.size,
      p.start,
      {
        sort: sort as IssueSort | "key",
        sessionActivity:
          sort === "key" ? [] : await sessionCatalog(sessionId || undefined),
        identity: ref,
      },
    );
    const { items, refreshing } = statuses?.annotate(listed) ?? {
      items: listed,
      refreshing: false,
    };
    return c.json({
      supportedSorts,
      sort,
      ...(ref === undefined ? {} : { ref }),
      items,
      ...(content ? { contentRefresh: content.status() } : {}),
      ...(refreshing ? { statusRefreshing: true } : {}),
      coverage: indexer.coverage(),
      nextOffset: items.length === p.size ? p.start + p.size : null,
    });
  });
  routes.route("/", createIssueContentRoutes(indexer.store, content));
  routes.get("/issues/sessions", async (c) => {
    const p = page(c.req.query("limit"), c.req.query("offset"));
    const id = c.req.query("id");
    const sort = c.req.query("sort") ?? "activity";
    if (!p || !id || id.length > 4096 || !["activity", "oldest"].includes(sort))
      return c.json({ error: "Invalid session request" }, 400);
    try {
      const catalog = new Map(
        (await sessionCatalog()).map((row) => [row.sessionId, row]),
      );
      const associations = indexer.store.sessions(
        id,
        c.req.query("dismissed") === "1",
      );
      const time = (sessionId: string) => {
        const value = Date.parse(catalog.get(sessionId)?.updatedAt ?? "");
        return Number.isFinite(value) ? value : null;
      };
      associations.sort((a, b) => {
        const x = time(a.sessionId),
          y = time(b.sessionId);
        if (x === null || y === null)
          return x === y
            ? a.sessionId.localeCompare(b.sessionId)
            : x === null
              ? 1
              : -1;
        return (
          (sort === "oldest" ? x - y : y - x) ||
          a.sessionId.localeCompare(b.sessionId)
        );
      });
      const sessions: IssueSession[] = [];
      for (const association of associations.slice(p.start, p.start + p.size)) {
        const row = catalog.get(association.sessionId);
        const source = await validSource(
          association.projectId,
          association.sessionId,
        );
        sessions.push({
          ...association,
          ...source,
          sessionId: association.sessionId,
          projectId: association.projectId,
          title: source.title ?? row?.title ?? undefined,
          updatedAt: row?.updatedAt,
          createdAt: source.createdAt ?? row?.createdAt,
          provider: source.provider ?? row?.provider,
          projectName: source.projectName ?? row?.projectName,
          sourceAvailable: source.available,
          evidence: indexer.store.evidence(
            id,
            1,
            0,
            association.sessionId,
            c.req.query("dismissed") === "1",
          ),
        });
      }
      return c.json({
        sessions,
        nextOffset:
          p.start + p.size < associations.length ? p.start + p.size : null,
      });
    } catch {
      return c.json({ error: "Sessions unavailable" }, 503);
    }
  });
  routes.get("/issues/evidence", async (c) => {
    const p = page(c.req.query("limit"), c.req.query("offset")),
      id = c.req.query("id");
    if (!p || !id || id.length > 4096)
      return c.json({ error: "Invalid evidence request" }, 400);
    try {
      const evidence = indexer.store.evidence(
        id,
        p.size,
        p.start,
        c.req.query("sessionId") ?? "",
        c.req.query("dismissed") !== "0",
      );
      const available = new Map<
        string,
        { available: boolean; title?: string }
      >();
      // At most one head lookup per session, bounded by the requested page.
      for (const item of evidence) {
        if (!available.has(item.sessionId))
          available.set(
            item.sessionId,
            await validSource(item.projectId, item.sessionId),
          );
        item.sourceAvailable = available.get(item.sessionId)!.available;
        item.sessionTitle = available.get(item.sessionId)!.title;
      }
      return c.json({
        evidence,
        nextOffset: evidence.length === p.size ? p.start + p.size : null,
      });
    } catch {
      return c.json({ error: "Evidence unavailable" }, 503);
    }
  });
  // The only way to ask a tracker about a reference twice. Automatic lookups
  // happen once per newly seen reference and never repeat on their own.
  routes.post("/issues/confirm", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body.projectId !== "string" ||
      typeof body.key !== "string" ||
      !body.key ||
      body.key.length > 4096 ||
      (body.provider !== "github" && body.provider !== "jira")
    )
      return c.json({ error: "Expected projectId, provider and key" }, 400);
    if (!confirmer || !indexer.settings().confirmation?.enabled)
      return c.json({ error: "Tracker confirmation is off" }, 403);
    if (!confirmer.recheck(body.projectId, body.provider, body.key))
      return c.json({ error: "No captured reference has that key" }, 404);
    await confirmer.drain();
    return c.json({ ok: true });
  });
  routes.post("/issues/decision", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body.id !== "string" ||
      body.id.length > 4096 ||
      typeof body.sessionId !== "string" ||
      !["confirmed", "dismissed", "discovered"].includes(body.state)
    )
      return c.json({ error: "Invalid association decision" }, 400);
    try {
      indexer.store.decide(body.id, body.sessionId, body.state);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Decision could not be saved" }, 400);
    }
  });
  routes.patch("/issues/item", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body.id !== "string" ||
      body.id.length > 4096 ||
      (body.title !== null &&
        (typeof body.title !== "string" || body.title.length > 512))
    )
      return c.json({ error: "Invalid title" }, 400);
    const title = indexer.store.title(body.id, body.title);
    return c.json({ ok: true, title });
  });
  routes.delete("/issues/item", async (c) => {
    const id = c.req.query("id");
    if (!id || id.length > 4096) return c.json({ error: "Invalid item" }, 400);
    try {
      indexer.delete(id);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Item could not be deleted" }, 400);
    }
  });
  routes.post("/issues/resolve", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body.url !== "string" ||
      !issueUrl(body.url) ||
      typeof body.projectId !== "string" ||
      typeof body.sessionId !== "string" ||
      (body.note !== undefined &&
        (typeof body.note !== "string" || body.note.length > 512))
    )
      return c.json(
        { error: "A supported issue URL and source session are required" },
        400,
      );
    if (body.key !== undefined && issueUrl(body.url)?.key !== body.key)
      return c.json({ error: "URL does not identify this reference" }, 400);
    if (!(await validSource(body.projectId, body.sessionId)).available)
      return c.json({ error: "Session unavailable in this project" }, 404);
    // Authorization/settings may have changed while the session was resolved.
    if (!indexer.settings().enabled)
      return c.json({ error: "Issue associations are disabled" }, 403);
    indexer.store.captureManual(
      { projectId: body.projectId, sessionId: body.sessionId },
      body.url,
      body.note ?? "",
    );
    indexer.resumePendingWork();
    return c.json({ ok: true });
  });
  return routes;
}
