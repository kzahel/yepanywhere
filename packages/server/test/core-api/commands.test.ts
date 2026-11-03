import { seedHistoricalReceiptAlias } from "../support/legacy-session-aliases.js";
import {
  PeerDirectory,
  fixturePeerGrant,
} from "../../src/peer-api/directory.js";
import { Hono } from "hono";
import { createV0Routes } from "../../src/routes/v0/index.js";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { ApiReceiptStore } from "../../src/core-api/receipt-store.js";
import {
  SessionCommands,
  type SessionCommandOwner,
} from "../../src/core-api/session-commands.js";
import { CoreApi, type CoreApiSources } from "../../src/core-api/service.js";
import { createSessionRequest } from "../../src/core-api/command-contracts.js";
import { SUPERUSER } from "../../src/auth/principal.js";
import {
  createAgentApiRuntime,
  type AgentApiRuntime,
} from "../../src/agent-api/runtime.js";

const project = { id: "p", name: "Project", path: "/fixture/project" };
const body = createSessionRequest.parse({
  requestId: "review-0001",
  projectId: "p",
  provider: "codex",
  message: "Review this change",
  thinking: "on:high",
});
function fixture(
  owner: SessionCommandOwner,
  database = openSqliteOrThrow(":memory:"),
) {
  migrateDiscoveryDatabase(database);
  const store = new ApiReceiptStore(database);
  let enabled = false;
  const commands = new SessionCommands("A", store, owner, () => enabled);
  const sessions = [
    {
      id: "parent",
      projectId: "p",
      provider: "codex",
      title: null,
      updatedAt: "",
      state: "in-turn",
    },
  ];
  const sources: CoreApiSources = {
    commands,
    projects: async () => ({ items: [project] }),
    providers: async () => [
      {
        id: "codex",
        name: "Codex",
        supportsSteering: true,
        supportsPermissionMode: true,
      },
    ],
    sessions: async () => ({ items: sessions }),
  };
  const core = new CoreApi("A", sources);
  return {
    sources,
    database,
    store,
    commands,
    core,
    sessions,
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
    },
    close() {
      commands.close();
      store.close();
      database.close();
    },
  };
}
function http(
  runtime: AgentApiRuntime,
  path: string,
  authorization: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        new URL(path, runtime.baseUrl),
        {
          socketPath: runtime.socketPath,
          agent: false,
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode!, body: JSON.parse(text) }),
          );
        },
      );
      req.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          Object.assign(
            new Error(
              `HTTP ${body === undefined ? "GET" : "POST"} ${path} (${body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body))} bytes): ${error.code}`,
            ),
            { code: error.code },
          ),
        ),
      );
      req.end(body === undefined ? undefined : JSON.stringify(body));
    },
  );
}

it.skipIf(process.platform === "win32")(
  "keeps existing grants read-only, attributes native admission, and deduplicates concurrent HTTP retries",
  async () => {
    let launches = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    const f = fixture({
      async start(_project, _request, _receipt, settled) {
        launches++;
        await pending;
        settled("child");
        return { sessionId: "child" };
      },
    });
    const runtime = await createAgentApiRuntime({
      serverId: "A",
      transport: "unix",
    });
    try {
      runtime.attachController(f.core);
      const read = runtime.issue({
        principal: SUPERUSER,
        sessionId: () => "parent",
      });
      const manage = runtime.issue({
        principal: SUPERUSER,
        sessionId: () => "parent",
        management: true,
      });
      const token = manage.environment.AGENT_YA_V0_AUTHORIZATION!;
      const path = "/v0/servers/A/sessions";
      expect((await http(runtime, path, token, body)).status).toBe(403);
      f.enable();
      expect(
        (
          await http(
            runtime,
            path,
            read.environment.AGENT_YA_V0_AUTHORIZATION!,
            body,
            { "X-Agent-Session-Id": "forged", "X-Management": "true" },
          )
        ).status,
      ).toBe(403);
      const access = await http(
        runtime,
        "/v0/servers/A/access",
        read.environment.AGENT_YA_V0_AUTHORIZATION!,
      );
      expect(access.body.operations).not.toContain("createSession");
      const [first, retry] = await Promise.all([
        http(runtime, path, token, body),
        http(runtime, path, token, body),
      ]);
      expect(first.status).toBe(202);
      expect(retry.status).toBe(202);
      expect(first.body.id).toBe(retry.body.id);
      expect(launches).toBe(1);
      expect(first.body.creator).toEqual({
        serverId: "A",
        sessionId: "parent",
        launchId: manage.launchId,
        principal: { kind: "superuser" },
      });
      expect(
        (await http(runtime, path, token, { ...body, message: "different" }))
          .status,
      ).toBe(409);
      expect(
        (
          await http(runtime, path, token, {
            ...body,
            creator: { sessionId: "forged" },
          })
        ).status,
      ).toBe(400);
      // Early size rejection can close an uploading Node client before its
      // body finishes; neither outcome may reserve or dispatch native work.
      const oversized = {
        ...body,
        requestId: "too-large",
        message: "界".repeat(90000),
      };
      const outcome = await http(runtime, path, token, oversized).then(
        (response) => response.status,
        (error: NodeJS.ErrnoException) => error.code,
      );
      expect([400, "EPIPE", "ECONNRESET"]).toContain(outcome);
      expect(launches).toBe(1);
      const app = new Hono<{ Variables: { yaPrincipal: typeof SUPERUSER } }>();
      app.use("*", async (c, next) => {
        c.set("yaPrincipal", SUPERUSER);
        await next();
      });
      app.route("/v0", createV0Routes(f.core));
      expect(
        (
          await app.request(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(oversized),
          })
        ).status,
      ).toBe(400);
      finish();
      await f.commands.idle();
      f.sessions.push({
        id: "child",
        projectId: "p",
        provider: "codex",
        title: null,
        updatedAt: "",
        state: "idle",
      });
      const receipt = await http(
        runtime,
        `/v0/servers/A/receipts/${first.body.id}`,
        token,
      );
      expect(receipt.body).toMatchObject({
        state: "accepted",
        sessionId: "child",
        delivery: "unknown",
        completion: "unknown",
      });
      const target = await http(
        runtime,
        "/v0/servers/A/sessions/child/relationships",
        token,
      );
      expect(target.body.creation).toMatchObject({
        id: first.body.id,
        creator: { sessionId: "parent" },
      });
      const parent = await http(
        runtime,
        "/v0/servers/A/sessions/parent/relationships",
        token,
      );
      expect(parent.body.initiated as unknown[]).toHaveLength(1);
      const schema = await http(
        runtime,
        "/v0/schema?operation=createSession",
        token,
      );
      const paths = schema.body.paths as Record<string, unknown>;
      expect(Object.keys(paths)).toEqual(["/v0/servers/{serverId}/sessions"]);
      expect(paths["/v0/servers/{serverId}/sessions"]).toHaveProperty(
        "post.requestBody",
      );
    } finally {
      finish();
      await f.commands.idle();
      await runtime.close();
      f.close();
    }
  },
);

it("persists request identity across reopen, marks interrupted work uncertain, and preserves both ends through remap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-receipts-"));
  let f: ReturnType<typeof fixture> | undefined;
  try {
    const path = join(dir, "discovery.sqlite");
    f = fixture(
      {
        async start() {
          return { queueId: "native-queue" };
        },
      },
      openSqliteOrThrow(path),
    );
    f.enable();
    const launch = {
      id: "parent",
      launchId: "launch-a",
      management: true as const,
    };
    const first = await f.core.call("createSession", SUPERUSER, {
      serverId: "A",
      body,
      launch,
    });
    expect(first).toHaveProperty("id");
    const id = (first as { id: string }).id;
    await f.commands.idle();
    expect(f.store.get(id)?.state).toBe("queued");
    f.sources.projects = async () => ({ items: [] });
    f.sources.providers = async () => [];
    expect(
      await f.core.call("createSession", SUPERUSER, { body, launch }),
    ).toMatchObject({ id, state: "queued" });
    f.close();
    let relaunched = 0;
    f = fixture(
      {
        async start() {
          relaunched++;
          return { sessionId: "unexpected" };
        },
        async recover() {
          return undefined;
        },
      },
      openSqliteOrThrow(path),
    );
    f.enable();
    const replay = await f.core.call("createSession", SUPERUSER, {
      body,
      launch: { ...launch, launchId: "launch-b" },
    });
    expect(replay).toMatchObject({
      id,
      state: "uncertain",
      queueId: "native-queue",
    });
    expect(relaunched).toBe(0);
    seedHistoricalReceiptAlias(f.store, "parent", "canonical-parent");
    const remapped = await f.core.call("createSession", SUPERUSER, {
      body,
      launch: { ...launch, id: "canonical-parent" },
    });
    expect(remapped).toMatchObject({
      id,
      creator: { sessionId: "canonical-parent", launchId: "launch-a" },
    });
    f.store.update(id, { sessionId: "child", state: "accepted" });
    seedHistoricalReceiptAlias(f.store, "child", "canonical-child");
    expect(
      f.store.relationships("canonical-child", 0, 50).creation,
    ).toMatchObject({ id, sessionId: "canonical-child" });
    expect(
      f.store.relationships("canonical-parent", 0, 50).initiated[0]?.id,
    ).toBe(id);
    const other = await f.core.call("createSession", SUPERUSER, {
      body,
      launch: { ...launch, id: "different-source" },
    });
    expect((other as { id: string }).id).not.toBe(id);
    await f.commands.idle();
  } finally {
    f?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("records ambiguous launch failures without repeating work and reconciles only unique owner evidence", async () => {
  let launches = 0;
  const owner: SessionCommandOwner = {
    async start() {
      launches++;
      throw new Error("provider exited after launch boundary");
    },
    async recover() {
      return { sessionId: "native-child" };
    },
  };
  const f = fixture(owner);
  f.enable();
  try {
    const first = await f.core.call("createSession", SUPERUSER, { body });
    const id = (first as { id: string }).id;
    await f.commands.idle();
    expect(f.store.get(id)).toMatchObject({
      state: "uncertain",
      sessionId: null,
    });
    expect(
      await f.core.call("createSession", SUPERUSER, { body }),
    ).toMatchObject({ id, state: "uncertain" });
    expect(launches).toBe(1);
    expect(
      await f.core.call("receipt", SUPERUSER, { receiptId: id }),
    ).toMatchObject({
      state: "accepted",
      sessionId: "native-child",
      delivery: "uncertain",
    });
    await expect(
      f.core.call("createSession", SUPERUSER, {
        body,
        launch: { id: null, launchId: "pending", management: true },
      }),
    ).rejects.toMatchObject({ status: 409, code: "identity_pending" });
  } finally {
    f.close();
  }
});

it("rechecks current enablement after async catalog lookup and before reservation", async () => {
  let launched = 0;
  const f = fixture({
    async start() {
      launched++;
      return { sessionId: "unexpected" };
    },
  });
  f.enable();
  let release!: (value: { items: (typeof project)[] }) => void;
  f.sources.projects = () => new Promise((resolve) => (release = resolve));
  try {
    const pending = f.core.call("createSession", SUPERUSER, { body });
    f.disable();
    release({ items: [project] });
    await expect(pending).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
    await f.commands.idle();
    expect(launched).toBe(0);
    expect(f.commands.replayCreate(body)).toBeUndefined();
  } finally {
    f.close();
  }
});

it("rechecks a queued peer creation's actual grant before native dispatch without replacing its trusted creator", async () => {
  let authority: (() => Promise<void>) | undefined;
  const f = fixture({
    start: async (
      _project,
      _request,
      _receipt,
      _settled,
      _failed,
      _consumed,
      _admitted,
      authorize,
    ) => {
      authority = authorize;
      return { queueId: "owned-queued-command" };
    },
  });
  const grant = fixturePeerGrant(
    "source-peer",
    "owned-peer-token-at-least-thirty-two-characters",
    ["p"],
    ["createSession"],
  );
  const directory = new PeerDirectory([grant]);
  const lease = directory.authenticate(
    "owned-peer-token-at-least-thirty-two-characters",
    { sessionId: "source-session", launchId: "source-launch" },
  );
  f.enable();
  try {
    const created = await f.core.read("createSession", lease.principal, {
      body,
    });
    await f.commands.idle();
    expect(authority).toBeTypeOf("function");
    await authority!();
    directory.revoke(grant.id);
    await expect(authority!()).rejects.toThrow("Peer credential is not active");
    expect(f.store.get((created as { id: string }).id)?.creator).toMatchObject({
      principal: { kind: "peer" },
      serverId: "source-peer",
      sessionId: "source-session",
      authentication: { credentialId: grant.id },
    });
  } finally {
    lease.release();
    directory.close();
    f.close();
  }
});
