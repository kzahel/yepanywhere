import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_LIMITED_USER_GRANTS } from "@yep-anywhere/shared";
import {
  type Principal,
  PRINCIPAL_VARIABLE,
  SUPERUSER,
} from "../../src/auth/principal.js";
import {
  operations,
  operationMethod,
  apiSchema,
  operationDocumentation,
  type ApiSession,
} from "../../src/core-api/contracts.js";
import { CoreApi, type CoreApiSources } from "../../src/core-api/service.js";
import {
  createConversationRead,
  createConversationFollow,
} from "../../src/core-api/conversation.js";
import { ConversationSubscriptions } from "../../src/experimental/conversation-subscriptions.js";
import { createV0Routes } from "../../src/routes/v0/index.js";

const alice: Principal = {
  kind: "limited",
  username: "alice",
  grants: { ...EMPTY_LIMITED_USER_GRANTS, viewProjects: ["visible", "hidden"] },
  switched: false,
  locked: true,
  via: "direct",
};
const row = (
  id: string,
  projectId: string,
  createdByUser?: string,
): ApiSession => ({
  id,
  projectId,
  createdByUser,
  title: id,
  updatedAt: "2026-10-30T00:00:00Z",
  provider: "claude",
  state: "not-running",
});
function fixture(
  id: string,
  caller: Principal | null = alice,
  rows = [
    row("a", "private"),
    row("b", "visible"),
    row("c", "visible"),
    row("d", "private", "alice"),
    row("e", "hidden"),
  ],
) {
  const subscriptions = new ConversationSubscriptions(async (sessionId) => ({
    close() {},
    async read() {
      return {
        sessionId,
        activity: "idle",
        messages: [
          { type: "user", uuid: "q", content: "What shipped?" },
          {
            type: "assistant",
            uuid: "a",
            content: [
              { type: "thinking", thinking: "private-reasoning" },
              { type: "text", text: "Shipped **Orchid**." },
            ],
          },
        ],
        pendingRequests: [],
        sourceCoverage: { complete: true, earlierOutsideScope: "no" },
      };
    },
  }));
  const sources: CoreApiSources = {
    projects: async () => ({
      items: ["private", "visible", "hidden"].map((id) => ({
        id,
        name: id,
        path: `/work/${id}`,
      })),
    }),
    sessions: async () => ({
      items: rows,
      catalog: { complete: true, refreshing: false },
    }),
    providers: async () => [
      {
        id: "claude",
        name: "Claude",
        supportsSteering: true,
        supportsPermissionMode: true,
      },
    ],
    hiddenProjects: async () => new Set(["hidden"]),
    conversation: createConversationRead(subscriptions),
    followConversation: createConversationFollow(subscriptions, id),
  };
  const api = new CoreApi(id, sources);
  const app = new Hono<{ Variables: { yaPrincipal: Principal } }>();
  app.use("*", async (c, next) => {
    if (caller) c.set(PRINCIPAL_VARIABLE, caller);
    await next();
  });
  app.route("/v0", createV0Routes(api));
  return { app, api, sources };
}

describe("isolated v0 application and HTTP reads", () => {
  it("scopes catalog pages before slicing, keeps creator access and rejects unknown targets", async () => {
    const { app } = fixture("A");
    const page = await (
      await app.request("/v0/servers/A/sessions?limit=1")
    ).json();
    expect(page.items.map((s: ApiSession) => s.id)).toEqual(["b"]);
    expect(page.nextCursor).toBe("1");
    const next = await (
      await app.request("/v0/servers/A/sessions?limit=1&cursor=1")
    ).json();
    expect(next.items.map((s: ApiSession) => s.id)).toEqual(["c"]);
    expect((await app.request("/v0/servers/A/sessions/a")).status).toBe(404);
    expect((await app.request("/v0/servers/A/sessions/d")).status).toBe(200);
    expect((await app.request("/v0/servers/A/sessions/e")).status).toBe(200);
    expect(
      (await (await app.request("/v0/servers/A/projects")).json()).items.map(
        (p: { id: string }) => p.id,
      ),
    ).toEqual(["visible"]);
    expect((await app.request("/v0/servers/B/sessions")).status).toBe(404);
    expect(
      (
        await (
          await app.request("/v0/servers/A/sessions?projectId=private")
        ).json()
      ).items.map((s: ApiSession) => s.id),
    ).toEqual(["d"]);
  });

  it("does not let an ambiguous session id select a different project's history", async () => {
    const { app } = fixture("A", alice, [
      row("collision", "private"),
      row("collision", "visible"),
    ]);
    expect((await app.request("/v0/servers/A/sessions/collision")).status).toBe(
      404,
    );
    expect(
      (await (await app.request("/v0/servers/A/sessions")).json()).items,
    ).toEqual([]);
  });

  it("describes real response schemas, isolates instances and exposes no inferred caller session", async () => {
    const { app } = fixture("A"),
      other = fixture("B", SUPERUSER);
    expect((await (await other.app.request("/v0")).json()).serverId).toBe("B");
    for (const operation of operations) {
      if (
        operationMethod(operation) === "POST" ||
        operation.id === "selection" ||
        operation.id === "followReceipt" ||
        operation.id === "receipt" ||
        operation.id === "relationships"
      )
        continue;
      const path = `/v0${operation.path.replace(":serverId", "A").replace(":sessionId", "b")}`;
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(
        operation.response.safeParse(
          ["help", "targetHelp"].includes(operation.id)
            ? await response.text()
            : await response.json(),
        ).success,
        path,
      ).toBe(true);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect((await (await app.request("/v0/me")).json()).session).toBeNull();
    const schema = await (await app.request("/v0/schema")).json();
    expect(schema).toEqual(apiSchema());
    expect(
      schema.paths["/v0/servers/{serverId}/providers"].get.parameters.map(
        (p: { name: string }) => p.name,
      ),
    ).not.toContain("projectId");
    expect(
      (await app.request("/v0/servers/A/providers?projectId=visible")).status,
    ).toBe(400);
    expect(
      schema.paths["/v0/servers/{serverId}/sessions"].get.parameters.map(
        (p: { name: string }) => p.name,
      ),
    ).toContain("limit");
    expect((await app.request("/v0/servers/A/sessions?limit=101")).status).toBe(
      400,
    );
    expect((await app.request("/v0/servers/A/sessions?cursor=-1")).status).toBe(
      400,
    );
    expect((await fixture("A", null).app.request("/v0")).status).toBe(401);
  });

  it("executes the served guide's examples with discovered ids and follows its pagination contract", async () => {
    const { app } = fixture("A");
    const root = await (await app.request("/v0")).json();
    const helpResponse = await app.request(root.help);
    expect(helpResponse.headers.get("content-type")).toContain("text/markdown");
    const help = await helpResponse.text();
    expect(help).toContain("read-only launch credentials");
    const projects = await (
      await app.request(
        operationDocumentation.projects.example.replace(
          "{serverId}",
          encodeURIComponent(root.serverId),
        ),
      )
    ).json();
    const project = projects.items.find(
      (p: { name: string }) => p.name === "visible",
    );
    expect(project).toBeDefined();
    const sessionsPath = operationDocumentation.sessions.example
      .replace("{serverId}", root.serverId)
      .replace("{projectId}", encodeURIComponent(project.id));
    expect(help).toContain(operationDocumentation.sessions.example);
    const first = await (await app.request(sessionsPath)).json();
    const next = await (
      await app.request(`${sessionsPath}&cursor=${first.nextCursor}`)
    ).json();
    expect([first.items[0].id, next.items[0].id]).toEqual(["b", "c"]);
    expect(next.nextCursor).toBeNull();
    const summaryPath = operationDocumentation.session.example
      .replace("{serverId}", root.serverId)
      .replace("{sessionId}", encodeURIComponent(next.items[0].id));
    expect((await (await app.request(summaryPath)).json()).id).toBe("c");
    expect((await fixture("A", null).app.request("/v0/help")).status).toBe(401);
  });

  it("authorizes compact reads before acquisition, reports window limits, and documents executable queries", async () => {
    const { app, sources } = fixture("A");
    const read = vi.fn(sources.conversation!);
    sources.conversation = read;
    expect(
      (await app.request("/v0/servers/A/sessions/a/conversation")).status,
    ).toBe(404);
    expect(read).not.toHaveBeenCalled();
    const path = "/v0/servers/A/sessions/b/conversation";
    const response = await app.request(path + "?maxMessages=1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toEqual([
      { kind: "text", format: "markdown", text: "Shipped **Orchid**." },
    ]);
    expect(body.coverage.earlierInScope).toBe(true);
    expect(body.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain("private-reasoning");
    expect((await app.request(path + "?maxMessages=101")).status).toBe(400);
    expect((await app.request(path + "?limit=2")).status).toBe(400);
    expect((await app.request(path + "?anchorMessageId=unknown")).status).toBe(
      404,
    );
  });

  it("orders fractional timestamps and timezone offsets chronologically before pagination", async () => {
    const rows = [
      { ...row("older", "visible"), updatedAt: "2026-10-30T00:00:00Z" },
      { ...row("newer", "visible"), updatedAt: "2026-10-30T00:00:00.100Z" },
      {
        ...row("newest", "visible"),
        updatedAt: "2026-10-30T02:00:00.200+02:00",
      },
    ];
    const { app } = fixture("A", SUPERUSER, rows);
    const first = await (
      await app.request("/v0/servers/A/sessions?limit=1")
    ).json();
    expect(first.items.map((s: ApiSession) => s.id)).toEqual(["newest"]);
    const second = await (
      await app.request("/v0/servers/A/sessions?limit=1&cursor=1")
    ).json();
    expect(second.items.map((s: ApiSession) => s.id)).toEqual(["newer"]);
  });

  it("enforces scope without HTTP and passes cancellation to the source", async () => {
    const { api, sources } = fixture("A");
    expect(
      await api.read("session", alice, { serverId: "A", sessionId: "d" }),
    ).toMatchObject({ id: "d" });
    await expect(
      api.read("session", alice, { sessionId: "a" }),
    ).rejects.toMatchObject({ status: 404 });
    sources.sessions = async () => ({
      items: [],
      catalog: { complete: false, refreshing: true },
    });
    await expect(
      api.read("session", alice, { sessionId: "not-yet-known" }),
    ).rejects.toMatchObject({ status: 503, code: "catalog_not_ready" });
    const controller = new AbortController();
    sources.projects = async (signal) => {
      expect(signal).toBe(controller.signal);
      signal?.throwIfAborted();
      return { items: [] };
    };
    controller.abort();
    await expect(
      api.read("projects", alice, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
